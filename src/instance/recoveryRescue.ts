/**
 * Receiver-side rescue orchestration (PLAN_REPLICATION.md Section 18, RC-3).
 *
 * Runs on the machine whose database is being REPLACED. Drives the whole
 * sequence through the armed channel: preflight (dump the stale copy) ->
 * bulk (resumable rsync of the live source PGDATA, no consistency needed) ->
 * consistent (short delta pass inside pg_backup_start/stop) -> standby
 * (backup_label + standby.signal + primary_conninfo through the tunnel's
 * postgres lane on the dedicated recovery_channel slot) -> streaming (monitor
 * until caught up; RC-4's swap takes it from there).
 *
 * Every phase is persisted before it runs and idempotently re-enterable: the
 * boot resume re-enters the recorded phase, the bulk rsync is delta by
 * nature, the consistent pass just re-runs, and a died backup session
 * self-cleans on the source. Retryable failures loop with a fixed delay
 * until cancel; only structural ones (channel gone, database record gone)
 * park the rescue at its recorded phase for Continue to re-enter.
 */

import { execFile } from 'child_process';
import * as containerManager from '../docker/containerManager';
import { runFleetDump } from './fleetBackup';
import { InstanceConfig, RecoveryRescueRecord } from '../types';

const PGDATA = '/var/lib/postgresql/data';
const RETRY_DELAY_MS = 30_000;
const MONITOR_INTERVAL_MS = 30_000;
const RSYNC_POLL_MS = 10_000;
const DOCKER_TIMEOUT_MS = 60_000;

function docker(args: string[], stdin?: string): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise(resolve => {
    const child = execFile('docker', args, { timeout: DOCKER_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => resolve({ ok: !err, stdout: String(stdout || ''), stderr: String(stderr || err || '') }));
    if (stdin !== undefined && child.stdin) { child.stdin.write(stdin); child.stdin.end(); }
  });
}

function rsyncClientName(instance: InstanceConfig): string {
  return `${instance.sanitizedName}-recovery-rsync`;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── Control lane client (the receiver drives the source through the tunnel) ───

async function control(instance: InstanceConfig, action: string, method: 'GET' | 'POST' = 'POST'): Promise<{ ok: boolean; body?: any; error?: string }> {
  const record = instance.recoveryChannel;
  if (!record || record.mode !== 'receiver') return { ok: false, error: 'no armed receiver channel' };
  // The listener helper's control lane; both this manager and the helper sit
  // on the shared docker network. The shared channel token authenticates the
  // request AND selects the armed source on the far side (this machine's
  // instance ids mean nothing over there).
  const url = `http://${record.containerName}:8946/control/${action}`;
  try {
    const res = await fetch(url, {
      method,
      headers: { 'x-recovery-token': record.token },
      signal: AbortSignal.timeout(150_000),
    });
    const body: any = await res.json().catch(() => null);
    if (!res.ok || !body || body.success !== true) {
      return { ok: false, error: String(body?.error || `control ${action} returned ${res.status}`) };
    }
    return { ok: true, body };
  } catch (err) {
    return { ok: false, error: `control ${action} unreachable: ${err instanceof Error ? err.message : String(err)}` };
  }
}

// ─── Volume plumbing ───

function volExec(volume: string, script: string, stdin?: string): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return docker(['run', '--rm', ...(stdin !== undefined ? ['-i'] : []),
    '-v', `${volume}:${PGDATA}`, '--entrypoint', 'sh', 'postgres:16-alpine', '-c', script], stdin);
}

async function volumeHasDatabase(volume: string): Promise<boolean> {
  const probe = await volExec(volume, `test -f ${PGDATA}/PG_VERSION && echo yes || echo no`);
  return probe.ok && probe.stdout.trim() === 'yes';
}

// ─── Phase record plumbing ───

function saveRescue(botId: string, patch: Partial<RecoveryRescueRecord>): RecoveryRescueRecord | null {
  const instance = containerManager.getBot(botId);
  const current = instance?.recoveryRescue;
  if (!instance || !current) return null;
  const next = { ...current, ...patch, updatedAt: Date.now() };
  containerManager.updateInstanceRecoveryRescue(botId, next);
  return next;
}

/** Structural preconditions; failing any parks the rescue rather than retrying. */
function structurallySound(instance: InstanceConfig | null): instance is InstanceConfig {
  return !!instance && !!instance.fleetDb && instance.recoveryChannel?.mode === 'receiver' && !!instance.recoveryRescue;
}

// ─── The driver ───

const running = new Set<string>();

export async function startRescue(
  instance: InstanceConfig,
  confirm: boolean,
): Promise<{ success: boolean; error?: string; needsConfirm?: boolean; state?: 'fresh' | 'outdated'; sourceIdentity?: Record<string, unknown> }> {
  if (!instance.fleetDb) return { success: false, error: 'This instance has no managed fleet database to receive into' };
  if (instance.recoveryChannel?.mode !== 'receiver') return { success: false, error: 'Arm the recovery channel receiver first' };
  if (instance.status === 'running') return { success: false, error: 'Stop the instance first: the rescue replaces the database it runs on' };
  if (instance.recoveryRescue) {
    // Re-entry ALWAYS continues the recorded phase (Continue after a manager
    // outage or a parked halt); restarting from preflight would boot postgres
    // over a half-seeded volume to "dump" garbage.
    if (instance.recoveryRescue.parked) saveRescue(instance.id, { parked: false, lastError: undefined });
    if (!running.has(instance.id)) void runRescue(instance.id);
    return { success: true };
  }

  const prepared = await control(instance, 'prepare');
  if (!prepared.ok) return { success: false, error: `The source did not answer through the tunnel: ${prepared.error}` };
  const outdated = await volumeHasDatabase(instance.fleetDb.volume);
  if (!confirm) {
    // FRESH vs OUTDATED is a prompt difference by design (Section 15): the
    // mechanism is identical, the operator confirms a different sentence.
    return {
      success: false,
      needsConfirm: true,
      state: outdated ? 'outdated' : 'fresh',
      sourceIdentity: prepared.body.identity,
    };
  }
  const record: RecoveryRescueRecord = { phase: 'preflight', startedAt: Date.now(), updatedAt: Date.now() };
  containerManager.updateInstanceRecoveryRescue(instance.id, record);
  void runRescue(instance.id);
  return { success: true };
}

export async function cancelRescue(instance: InstanceConfig): Promise<{ success: boolean; error?: string }> {
  if (!instance.recoveryRescue) return { success: false, error: 'No rescue is running on this instance' };
  // The client must be PROVEN gone before the record clears: the start-guard
  // keys on the record, and an orphan rsync rewriting the volume under a
  // freshly started postgres is the corruption this ordering prevents.
  const rm = await docker(['rm', '-f', rsyncClientName(instance)]);
  if (!rm.ok && !/no such container/i.test(rm.stderr)) {
    return { success: false, error: `could not remove the rsync client: ${rm.stderr.trim().split('\n').pop()}` };
  }
  containerManager.updateInstanceRecoveryRescue(instance.id, null);
  // A driver mid-rsyncPass may recreate the client in a narrow window; its
  // next poll sees the cleared record and removes it again. Sweep once more
  // for the window where the driver died between create and poll.
  setTimeout(() => { void docker(['rm', '-f', rsyncClientName(instance)]); }, 15_000).unref();
  // The seeded/partial volume stays as-is: the operator decides what happens
  // next (re-run, disarm, or normal re-provision paths).
  return { success: true };
}

export function getRescueStatus(instance: InstanceConfig): RecoveryRescueRecord | null {
  return instance.recoveryRescue ?? null;
}

/** Boot resume: re-enter every recorded phase that is not parked. */
export function resumeRecoveryRescues(): void {
  for (const instance of containerManager.getAllBots()) {
    const rescue = instance.recoveryRescue;
    if (!rescue || rescue.parked) continue;
    console.log(`[RecoveryRescue] Resuming rescue for ${instance.displayName} at phase ${rescue.phase}`);
    void runRescue(instance.id);
  }
}

async function runRescue(botId: string): Promise<void> {
  if (running.has(botId)) return;
  running.add(botId);
  try {
    for (;;) {
      const instance = containerManager.getBot(botId);
      if (!structurallySound(instance)) {
        if (containerManager.getBot(botId)?.recoveryRescue) {
          saveRescue(botId, { parked: true, lastError: 'the channel or the database record disappeared mid-rescue' });
        }
        return;
      }
      if (instance.recoveryRescue!.parked) return;
      const phase = instance.recoveryRescue!.phase;
      try {
        if (phase === 'preflight') await phasePreflight(instance);
        else if (phase === 'bulk') await phaseBulk(instance);
        else if (phase === 'consistent') await phaseConsistent(instance);
        else if (phase === 'standby') await phaseStandby(instance);
        else if (phase === 'streaming') { await phaseMonitor(instance); return; }
        else return;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`[RecoveryRescue] ${instance.displayName} phase ${phase} failed: ${message}; retrying in ${RETRY_DELAY_MS / 1000}s`);
        saveRescue(botId, { lastError: message });
        await sleep(RETRY_DELAY_MS);
        // The rescue record may have been cancelled during the sleep.
        if (!containerManager.getBot(botId)?.recoveryRescue) return;
      }
    }
  } finally {
    running.delete(botId);
  }
}

// ─── Phases ───

/** Stop the sidecar and PROVE it stopped: rsync over a running postgres is the one corruption this phase exists to prevent. Missing container = stopped. */
async function stopSidecarHard(containerName: string): Promise<void> {
  const stop = await docker(['stop', containerName]);
  if (!stop.ok && !/no such container/i.test(stop.stderr)) {
    throw new Error(`could not stop the database container: ${stop.stderr.trim().split('\n').pop()}`);
  }
  const state = await docker(['inspect', '--format', '{{.State.Running}}', containerName]);
  if (state.ok && state.stdout.trim() === 'true') {
    throw new Error('the database container is still running after the stop');
  }
}

async function phasePreflight(instance: InstanceConfig): Promise<void> {
  const fleetDb = instance.fleetDb!;
  const rescue = instance.recoveryRescue!;
  // The marker survives cancel + restart cycles inside the volume itself: a
  // half-seeded PGDATA still has PG_VERSION, and "dumping" it would boot
  // postgres over inconsistent data.
  const marker = await volExec(fleetDb.volume, `test -f ${PGDATA}/rescue.inprogress && echo yes || echo no`);
  const alreadyMidRescue = marker.ok && marker.stdout.trim() === 'yes';
  if (!rescue.dumpDone && !alreadyMidRescue && await volumeHasDatabase(fleetDb.volume)) {
    // The stale copy gets one dump beside the ordinary backups; best effort
    // by the same ruling as the re-seed lane (the operator already accepted
    // losing the diverged tail, the dump is a safety net not a precondition).
    const started = await containerManager.startFleetDbSidecar(instance.id);
    const dump = started.success ? await runFleetDump(instance, 'pre-rescue-') : { success: false, error: started.error };
    if (!dump.success) console.warn(`[RecoveryRescue] Could not dump the stale copy before the rescue of ${instance.id}: ${dump.error}`);
  }
  await stopSidecarHard(fleetDb.containerName);
  const mark = await volExec(fleetDb.volume, `touch ${PGDATA}/rescue.inprogress`);
  if (!mark.ok) throw new Error(`could not mark the volume: ${mark.stderr.trim()}`);
  saveRescue(instance.id, { phase: 'bulk', dumpDone: true, lastError: undefined });
}

/**
 * One rsync pass as a detached container, polled to completion; throws on a
 * failing exit so the driver retries. Delta by nature, so retry = resume.
 * The pass kind is stamped as a label: a consistent-phase re-entry must never
 * adopt a still-running BULK container from before a crash (its files predate
 * the backup window). The consistent pass adds --checksum, because the
 * quick-check (size+mtime) misses an 8k page rewritten in the same second the
 * bulk pass copied it - postgres files never change size.
 */
async function rsyncPass(instance: InstanceConfig, pass: 'bulk' | 'consistent'): Promise<void> {
  const fleetDb = instance.fleetDb!;
  const channel = instance.recoveryChannel!;
  const name = rsyncClientName(instance);
  const state = await docker(['inspect', '--format', '{{.State.Running}} {{index .Config.Labels "rescue-pass"}}', name]);
  // Only a BULK pass may be adopted: a running consistent-pass container from
  // before a manager crash predates the CURRENT backup window (backup-start
  // re-runs on every consistent entry), and pages it copied in the gap would
  // never be revisited nor repaired by replay.
  const adoptable = pass === 'bulk' && state.ok && state.stdout.trim() === `true ${pass}`;
  if (!adoptable) {
    if (!containerManager.getBot(instance.id)?.recoveryRescue) throw new Error('rescue cancelled');
    await docker(['rm', '-f', name]);
    const image = await docker(['inspect', '--format', '{{.Config.Image}}', channel.containerName]);
    if (!image.ok || !image.stdout.trim()) throw new Error('could not resolve the relay image for the rsync client');
    const network = await docker(['inspect', '--format', '{{range $k, $v := .NetworkSettings.Networks}}{{$k}}\n{{end}}', channel.containerName]);
    const net = network.ok ? network.stdout.split('\n').map(s => s.trim()).filter(Boolean)[0] : '';
    if (!net) throw new Error('could not resolve the relay network for the rsync client');
    if (!containerManager.getBot(instance.id)?.recoveryRescue) throw new Error('rescue cancelled');
    const run = await docker(['run', '-d', '--name', name,
      '--label', `rescue-pass=${pass}`,
      '--network', net,
      '-v', `${fleetDb.volume}:/pgdata`,
      '--entrypoint', 'sh', image.stdout.trim(), '-c',
      `exec rsync -a --delete --partial ${pass === 'consistent' ? '--checksum ' : ''}--exclude=rescue.inprogress --exclude=postmaster.pid --exclude=postmaster.opts --exclude=pg_replslot/** --exclude=pg_dynshmem/** --exclude=pg_notify/** --exclude=pg_serial/** --exclude=pg_snapshots/** --exclude=pg_stat_tmp/** --exclude=pg_subtrans/** rsync://${channel.containerName}:873/pgdata/ /pgdata/`]);
    if (!run.ok) throw new Error(`could not start the rsync pass: ${run.stderr.trim().split('\n').pop()}`);
  }
  for (;;) {
    await sleep(RSYNC_POLL_MS);
    if (!containerManager.getBot(instance.id)?.recoveryRescue) {
      // The cancel path must not leave a detached rsync rewriting the volume
      // after the start-guard (which keys on the record) is gone.
      await docker(['rm', '-f', name]);
      throw new Error('rescue cancelled');
    }
    const poll = await docker(['inspect', '--format', '{{.State.Running}} {{.State.ExitCode}}', name]);
    if (!poll.ok) throw new Error('the rsync container disappeared');
    const [runningNow, exitCode] = poll.stdout.trim().split(' ');
    if (runningNow === 'true') continue;
    await docker(['rm', '-f', name]);
    // 24 = source files vanished mid-transfer: the expected outcome of
    // copying a LIVE data directory, not a failure.
    if (exitCode !== '0' && exitCode !== '24') throw new Error(`rsync exited with code ${exitCode}`);
    return;
  }
}

async function phaseBulk(instance: InstanceConfig): Promise<void> {
  await rsyncPass(instance, 'bulk');
  saveRescue(instance.id, { phase: 'consistent', lastError: undefined });
}

async function phaseConsistent(instance: InstanceConfig): Promise<void> {
  const fleetDb = instance.fleetDb!;
  const started = await control(instance, 'backup-start');
  if (!started.ok) throw new Error(started.error);
  if (!containerManager.getBot(instance.id)?.recoveryRescue) {
    await control(instance, 'backup-stop');
    throw new Error('rescue cancelled');
  }
  let stopResult: any;
  try {
    await rsyncPass(instance, 'consistent');
  } finally {
    const stopped = await control(instance, 'backup-stop');
    if (stopped.ok) stopResult = stopped.body.result;
  }
  if (!stopResult?.labelfile) throw new Error('pg_backup_stop returned no backup label; re-running the consistent pass');
  const label = String(stopResult.labelfile);
  // The transfer excludes the ephemeral dirs' CONTENTS, so an OUTDATED
  // receiver's stale leftovers (foreign replication slots above all) survive
  // rsync --delete and must go explicitly.
  const write = await volExec(fleetDb.volume,
    `cat > ${PGDATA}/backup_label && rm -f ${PGDATA}/postmaster.pid ${PGDATA}/postmaster.opts && rm -rf ${PGDATA}/pg_replslot/* ${PGDATA}/pg_dynshmem/* ${PGDATA}/pg_notify/* ${PGDATA}/pg_serial/* ${PGDATA}/pg_snapshots/* ${PGDATA}/pg_stat_tmp/* ${PGDATA}/pg_subtrans/* && chown postgres:postgres ${PGDATA}/backup_label && chmod 600 ${PGDATA}/backup_label`,
    label.endsWith('\n') ? label : label + '\n');
  if (!write.ok) throw new Error(`could not write backup_label: ${write.stderr.trim()}`);
  saveRescue(instance.id, { phase: 'standby', lastError: undefined });
}

async function phaseStandby(instance: InstanceConfig): Promise<void> {
  const fleetDb = instance.fleetDb!;
  const channel = instance.recoveryChannel!;
  const prepared = await control(instance, 'prepare');
  if (!prepared.ok) throw new Error(prepared.error);
  const replicator = prepared.body.replicator;
  // sslmode=disable is safe here: the wire is plaintext only between local
  // containers on each machine; the cross-host leg is the tunnel's TLS.
  // sslmode=require, not disable: the source's authored pg_hba accepts
  // replication over hostssl ONLY, and the relay lanes are raw byte pipes so
  // the SSLRequest handshake rides the tunnel end-to-end (require does not
  // verify the cert, so the source's self-signed pair passes).
  const conninfo = `host=${channel.containerName} port=5432 user=${replicator.user} password=${replicator.password} application_name=recovery_rescue sslmode=require`;
  const config = `primary_conninfo = '${conninfo}'\nprimary_slot_name = '${prepared.body.slot}'\n`;
  const write = await volExec(fleetDb.volume,
    `touch ${PGDATA}/standby.signal && rm -f ${PGDATA}/rescue.inprogress && sed -i '/^primary_conninfo/d;/^primary_slot_name/d' ${PGDATA}/postgresql.auto.conf && cat >> ${PGDATA}/postgresql.auto.conf && chown postgres:postgres ${PGDATA}/standby.signal ${PGDATA}/postgresql.auto.conf`,
    config);
  if (!write.ok) throw new Error(`could not author the standby config: ${write.stderr.trim()}`);
  const started = await containerManager.startFleetDbSidecar(instance.id);
  if (!started.success) {
    // Early recovery legitimately refuses connections past the ready wait;
    // the container being up is the phase's actual requirement.
    const state = await docker(['inspect', '--format', '{{.State.Running}}', fleetDb.containerName]);
    if (!(state.ok && state.stdout.trim() === 'true')) throw new Error(started.error || 'the standby container did not start');
  }
  saveRescue(instance.id, { phase: 'streaming', lastError: undefined });
}

async function phaseMonitor(instance: InstanceConfig): Promise<void> {
  const fleetDb = instance.fleetDb!;
  for (;;) {
    const fresh = containerManager.getBot(instance.id);
    if (!structurallySound(fresh)) {
      // A surviving record with a vanished channel/database must park loudly,
      // not leave a stale "catching up" with no driver behind it.
      if (containerManager.getBot(instance.id)?.recoveryRescue) {
        saveRescue(instance.id, { parked: true, lastError: 'the channel or the database record disappeared mid-streaming' });
      }
      return;
    }
    if (fresh.recoveryRescue!.phase !== 'streaming' || fresh.recoveryRescue!.parked) return;
    const status = await control(fresh, 'status', 'GET');
    if (status.ok && status.body.slotWalStatus === 'lost') {
      // The slot invalidated (retained WAL passed the source's bound): the
      // standby can never resume from it. Loud park beats an eternal
      // "catching up" - the fallback is a fresh seed (cancel + re-run).
      saveRescue(instance.id, { parked: true, caughtUp: false, lastError: 'the recovery slot on the source was invalidated (WAL bound exceeded); cancel and re-run the rescue to seed fresh' });
      return;
    }
    const sourceLsn = status.ok ? String(status.body.sourceLsn || '') : '';
    if (sourceLsn) {
      const probe = await docker(['exec', fleetDb.containerName, 'psql', '-U', fleetDb.user, '-d', fleetDb.db, '-tA', '-c',
        `SELECT pg_is_in_recovery(), GREATEST(pg_wal_lsn_diff('${sourceLsn}', pg_last_wal_replay_lsn()), 0)`]);
      if (probe.ok) {
        const [inRecovery, lag] = probe.stdout.trim().split('|');
        saveRescue(instance.id, {
          caughtUp: inRecovery === 't' && Number(lag) === 0,
          lagBytes: Number(lag) || 0,
          lastError: inRecovery === 'f' ? 'the rescued copy left recovery unexpectedly' : undefined,
        });
      } else {
        saveRescue(instance.id, { caughtUp: false, lastError: `standby unreachable: ${probe.stderr.trim().split('\n').pop()}` });
      }
    } else {
      saveRescue(instance.id, { caughtUp: false, lastError: status.error });
    }
    await sleep(MONITOR_INTERVAL_MS);
  }
}
