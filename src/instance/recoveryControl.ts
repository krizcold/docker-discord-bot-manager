/**
 * Recovery-channel SOURCE control plane (PLAN_REPLICATION.md Section 18, RC-3).
 *
 * A minimal HTTP server inside the source manager, bound to the docker
 * networks only (never published to the host), that the RECEIVER manager
 * drives through the tunnel's control lane. One operator surface (the
 * receiver) owns the whole rescue sequencing; this side only answers.
 *
 * Auth: every request carries the channel token of this instance's armed
 * source record. Narrow by construction: six routes (the RC-4 swap adds
 * quiesce + teardown), nothing else of the manager is reachable through the
 * lane.
 *
 * The backup session is a live `docker exec -i psql` child: postgres 15+
 * aborts backup mode when the session that called pg_backup_start dies, which
 * makes a manager restart mid-consistent-pass self-cleaning - the receiver
 * simply re-runs the short pass.
 */

import * as http from 'http';
import * as crypto from 'crypto';
import { spawn, execFile, ChildProcess } from 'child_process';
import * as containerManager from '../docker/containerManager';
import { InstanceConfig } from '../types';

export const RECOVERY_CONTROL_PORT = 8946;
const RECOVERY_SLOT = 'recovery_channel';
const DOCKER_TIMEOUT_MS = 30_000;
const SESSION_QUERY_TIMEOUT_MS = 120_000;

function docker(args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise(resolve => {
    execFile('docker', args, { timeout: DOCKER_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => resolve({ ok: !err, stdout: String(stdout || ''), stderr: String(stderr || err || '') }));
  });
}

function rsyncdName(instance: InstanceConfig): string {
  return `${instance.sanitizedName}-recovery-rsyncd`;
}

// ─── Persistent backup session (one per instance) ───

interface BackupSession {
  child: ChildProcess;
  buffer: string;
  waiter: { resolve: (line: string) => void; reject: (err: Error) => void } | null;
}

const sessions = new Map<string, BackupSession>();

/**
 * Run one single-line query on the session and return the single -tA output
 * row. A sentinel echo after each query marks end-of-result, because psql
 * gives no other framing on a pipe.
 */
function sessionQuery(session: BackupSession, sql: string): Promise<string> {
  return new Promise((resolve, reject) => {
    if (session.waiter) { reject(new Error('a session query is already running')); return; }
    const timer = setTimeout(() => {
      session.waiter = null;
      reject(new Error('backup session query timed out'));
    }, SESSION_QUERY_TIMEOUT_MS);
    session.waiter = {
      resolve: line => { clearTimeout(timer); session.waiter = null; resolve(line); },
      reject: err => { clearTimeout(timer); session.waiter = null; reject(err); },
    };
    if (!session.child.stdin || session.child.stdin.destroyed) {
      session.waiter.reject(new Error('backup session already closed'));
      return;
    }
    // The semicolon dispatches the statement; without it psql buffers the
    // query and \echo answers immediately with nothing.
    session.child.stdin.write(`${sql};\n\\echo __DONE__\n`);
  });
}

function openBackupSession(instance: InstanceConfig): BackupSession | null {
  const fleetDb = instance.fleetDb;
  if (!fleetDb) return null;
  // ON_ERROR_STOP makes a SQL error EXIT the session (close rejects the
  // waiter with the stderr tail); without it psql prints to stderr, still
  // echoes the sentinel, and a failed pg_backup_start would read as success.
  const child = spawn('docker', ['exec', '-i', fleetDb.containerName,
    'psql', '-U', fleetDb.user, '-d', fleetDb.db, '-tA', '-q', '-v', 'ON_ERROR_STOP=1']);
  const session: BackupSession = { child, buffer: '', waiter: null };
  let stderrTail = '';
  child.stderr!.on('data', chunk => { stderrTail = (stderrTail + String(chunk)).slice(-500); });
  child.stdin!.on('error', () => { /* close rejects the waiter; an EPIPE here must not crash the manager */ });
  child.stdout!.on('data', chunk => {
    session.buffer += String(chunk);
    const done = session.buffer.indexOf('__DONE__');
    if (done !== -1 && session.waiter) {
      const result = session.buffer.slice(0, done).trim();
      session.buffer = session.buffer.slice(done + 8);
      session.waiter.resolve(result);
    }
  });
  child.on('close', () => {
    // psql errors are multi-line (ERROR first, HINT/caret after): surface the
    // ERROR line, not whatever came last.
    const lines = stderrTail.trim().split('\n');
    const errorLine = [...lines].reverse().find(l => /^(ERROR|FATAL)/.test(l.trim())) || lines.pop() || '';
    session.waiter?.reject(new Error(`backup session closed${errorLine.trim() ? `: ${errorLine.trim()}` : ''}`));
    for (const [id, s] of sessions) if (s === session) sessions.delete(id);
  });
  child.on('error', () => { /* close follows */ });
  return session;
}

// ─── rsync daemon helper ───

/** The rsyncd config exposes exactly one read-only module over the tunnel's rsync lane; uid 0 so every PGDATA file is readable, -a on the client restores ownership. */
const RSYNCD_CONF = `[pgdata]
path = /pgdata
read only = yes
uid = 0
gid = 0
`;

export async function ensureRsyncDaemon(instance: InstanceConfig, image: string, network: string): Promise<{ ok: boolean; error?: string }> {
  const fleetDb = instance.fleetDb;
  if (!fleetDb) return { ok: false, error: 'no managed fleet database' };
  const name = rsyncdName(instance);
  const state = await docker(['inspect', '--format', '{{.State.Running}}', name]);
  if (state.ok && state.stdout.trim() === 'true') return { ok: true };
  await docker(['rm', '-f', name]);
  // The config rides an env var: a real multi-line value survives argv+env
  // verbatim, where printf-escape games do not (POSIX %s never expands \n).
  const run = await docker(['run', '-d', '--name', name, '--restart', 'unless-stopped',
    '--network', network,
    '-v', `${fleetDb.volume}:/pgdata:ro`,
    '-e', `RSYNCD_CONF=${RSYNCD_CONF}`,
    '--entrypoint', 'sh', image, '-c',
    'printf %s "$RSYNCD_CONF" > /etc/rsyncd.conf && exec rsync --daemon --no-detach']);
  if (!run.ok) return { ok: false, error: `could not start the rsync daemon: ${run.stderr.trim().split('\n').pop()}` };
  return { ok: true };
}

// ─── The control server ───

let server: http.Server | null = null;

function tokenOk(instance: InstanceConfig, offered: string): boolean {
  const expected = instance.recoveryChannel?.token || '';
  const a = Buffer.from(String(offered || ''));
  const b = Buffer.from(expected);
  return expected.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const send = (code: number, body: Record<string, unknown>): void => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const match = /^\/control\/(prepare|backup-start|backup-stop|status|quiesce|teardown)$/.exec(req.url || '');
  if (!match) { send(404, { success: false, error: 'unknown route' }); return; }
  const action = match[1];
  // The receiver cannot know this machine's instance ids; the channel token
  // both authenticates the request and selects which armed source it drives.
  // An ambiguous token (two armed sources sharing one) must refuse rather
  // than land backup commands on whichever database scans first.
  const offered = String(req.headers['x-recovery-token'] || '');
  const matches = containerManager.getAllBots().filter(b => b.recoveryChannel?.mode === 'source' && tokenOk(b, offered));
  if (matches.length === 0) {
    send(403, { success: false, error: 'no armed source channel matches that token' });
    return;
  }
  if (matches.length > 1) {
    send(409, { success: false, error: 'more than one armed source matches that token; disarm the stale one' });
    return;
  }
  const instance = matches[0];
  const fleetDb = instance.fleetDb;
  if (!fleetDb) { send(409, { success: false, error: 'instance lost its fleet database' }); return; }

  try {
    if (action === 'status') {
      const probe = await docker(['exec', fleetDb.containerName, 'psql', '-U', fleetDb.user, '-d', fleetDb.db, '-tA', '-c',
        `SELECT pg_current_wal_lsn(), (SELECT active FROM pg_replication_slots WHERE slot_name = '${RECOVERY_SLOT}'), (SELECT wal_status FROM pg_replication_slots WHERE slot_name = '${RECOVERY_SLOT}')`]);
      const [lsn, slotActive, walStatus] = probe.ok ? probe.stdout.trim().split('|') : ['', '', ''];
      send(200, { success: probe.ok, sourceLsn: lsn || null, slotActive: slotActive === 't', slotWalStatus: walStatus || null, backupInProgress: sessions.has(instance.id) });
      return;
    }
    if (action === 'prepare') {
      // Deliberately no slot here: prepare also answers the pre-confirm
      // probe, and the slot must not exist before the operator commits.
      // backup-start mints it RESERVED, the only form that retains WAL.
      const identity = await docker(['exec', fleetDb.containerName, 'psql', '-U', fleetDb.user, '-d', fleetDb.db, '-tA', '-c',
        "SELECT (SELECT system_identifier FROM pg_control_system()), (SELECT timeline_id FROM pg_control_checkpoint()), pg_current_wal_lsn()"]);
      const [systemId, timeline, lsn] = identity.ok ? identity.stdout.trim().split('|') : ['', '', ''];
      const repl = fleetDb.replication;
      if (!repl) { send(409, { success: false, error: 'replication posture missing on the source (adopt/enable first)' }); return; }
      send(200, {
        success: true,
        slot: RECOVERY_SLOT,
        replicator: { user: repl.role, password: repl.password },
        identity: { systemId, timeline: Number(timeline), lsn },
      });
      return;
    }
    if (action === 'backup-start') {
      // A lingering session (the receiver's backup-stop timed out mid-retry)
      // must never deadlock the rescue: killing it aborts backup mode on the
      // database, and the fresh start below begins a clean one.
      const stale = sessions.get(instance.id);
      if (stale) {
        sessions.delete(instance.id);
        stale.child.kill();
      }
      // The slot must be RESERVED from before the backup checkpoint, or the
      // source retains no WAL between backup-start and the standby's first
      // connect (an unreserved slot's restart_lsn is NULL and holds nothing).
      // A leftover that never reserved, was invalidated, or is past the bound
      // (unreserved: the backup checkpoint itself would flip it to lost) is
      // dropped first.
      const dropStale = await docker(['exec', fleetDb.containerName, 'psql', '-U', fleetDb.user, '-d', fleetDb.db, '-tA', '-c',
        `SELECT pg_drop_replication_slot(slot_name) FROM pg_replication_slots WHERE slot_name = '${RECOVERY_SLOT}' AND NOT active AND (restart_lsn IS NULL OR wal_status IN ('lost', 'unreserved'))`]);
      if (!dropStale.ok) { send(500, { success: false, error: `recovery slot cleanup: ${dropStale.stderr.trim().split('\n').pop()}` }); return; }
      const slot = await docker(['exec', fleetDb.containerName, 'psql', '-U', fleetDb.user, '-d', fleetDb.db, '-tA', '-c',
        `SELECT CASE WHEN EXISTS (SELECT FROM pg_replication_slots WHERE slot_name = '${RECOVERY_SLOT}') THEN 'kept'
                ELSE (SELECT 'reserved' FROM pg_create_physical_replication_slot('${RECOVERY_SLOT}', true)) END`]);
      if (!slot.ok || !slot.stdout.trim()) { send(500, { success: false, error: `recovery slot: ${slot.stderr.trim().split('\n').pop() || 'could not reserve'}` }); return; }
      const session = openBackupSession(instance);
      if (!session) { send(500, { success: false, error: 'could not open the backup session' }); return; }
      sessions.set(instance.id, session);
      try {
        const started = await sessionQuery(session, "SELECT pg_backup_start('recovery-channel', true)");
        if (!/^[0-9A-F]+\/[0-9A-F]+$/i.test(started)) throw new Error(`pg_backup_start did not return an LSN (${started || 'empty output'})`);
        send(200, { success: true, startLsn: started });
      } catch (err) {
        sessions.delete(instance.id);
        session.child.kill();
        send(500, { success: false, error: err instanceof Error ? err.message : String(err) });
      }
      return;
    }
    if (action === 'backup-stop') {
      const session = sessions.get(instance.id);
      if (!session) { send(409, { success: false, error: 'no backup mode is active' }); return; }
      try {
        const row = await sessionQuery(session, 'SELECT row_to_json(t) FROM pg_backup_stop(true) t');
        send(200, { success: true, result: JSON.parse(row) });
      } catch (err) {
        send(500, { success: false, error: err instanceof Error ? err.message : String(err) });
      } finally {
        sessions.delete(instance.id);
        session.child.stdin!.end();
        setTimeout(() => session.child.kill(), 2_000).unref();
      }
      return;
    }
    if (action === 'quiesce') {
      // Swap phase 1 (RC-4): stop the SOURCE BOT so nothing writes anymore,
      // but bring the database straight back up alone - it keeps serving the
      // tunnel until the receiver has replayed everything and promoted.
      // Container truth throughout: stopBot marks 'stopped' even when its
      // compose down fails, and a stale registry status would skip the stop
      // with the bot still writing - either way the captured LSN would fence
      // nothing. So the stop is verified against live containers, leftovers
      // are stopped by their exact names (label-scoped listing, never name
      // filters), and quiesce refuses while anything survives. Idempotent:
      // a re-entry finds everything down and just re-captures the LSN.
      if (containerManager.getBot(instance.id)?.status === 'running') {
        const stopped = await containerManager.stopBot(instance.id);
        if (!stopped.success && stopped.error !== 'Bot is not running') {
          send(500, { success: false, error: `could not stop the source instance: ${stopped.error}` });
          return;
        }
      }
      let leftovers = await containerManager.runningNonSidecarContainers(instance.id);
      if (leftovers === null) { send(500, { success: false, error: 'could not verify the source containers stopped' }); return; }
      if (leftovers.length > 0) {
        for (const name of leftovers) await docker(['stop', name]);
        leftovers = await containerManager.runningNonSidecarContainers(instance.id);
        if (leftovers === null || leftovers.length > 0) {
          send(500, { success: false, error: `source containers still running after the stop: ${(leftovers || ['unverifiable']).join(', ')}` });
          return;
        }
      }
      const up = await containerManager.startFleetDbSidecar(instance.id);
      if (!up.success) { send(500, { success: false, error: `the source database did not come back up alone: ${up.error}` }); return; }
      // Fence the DATABASE, not just this machine: fleet workers on other
      // hosts write here directly through the published port, and a commit
      // landing after the LSN capture would be silently discarded at promote.
      // Read-only default (sighup applies it to every session's next
      // transaction) plus a terminate sweep turns those writes into loud
      // refusals; replication is untouched. Disarm resets it. The leading
      // READ WRITE escape is defense-in-depth only - PG14+ allows ALTER
      // SYSTEM in read-only transactions.
      // ON_ERROR_STOP: with a -c sequence psql otherwise keeps going and
      // reports only the LAST command, so a failed ALTER SYSTEM under a
      // succeeding terminate would read as a successful fence.
      const fence = await docker(['exec', fleetDb.containerName, 'psql', '-U', fleetDb.user, '-d', fleetDb.db, '-tA', '-v', 'ON_ERROR_STOP=1',
        '-c', 'SET SESSION CHARACTERISTICS AS TRANSACTION READ WRITE',
        '-c', 'ALTER SYSTEM SET default_transaction_read_only = on',
        '-c', 'SELECT pg_reload_conf()',
        '-c', "SELECT count(pg_terminate_backend(pid)) FROM pg_stat_activity WHERE pid <> pg_backend_pid() AND backend_type = 'client backend'"]);
      if (!fence.ok) { send(500, { success: false, error: `could not fence the source database: ${fence.stderr.trim().split('\n').pop()}` }); return; }
      const lsn = await docker(['exec', fleetDb.containerName, 'psql', '-U', fleetDb.user, '-d', fleetDb.db, '-tA', '-c', 'SELECT pg_current_wal_lsn()']);
      const sourceLsn = lsn.ok ? lsn.stdout.trim() : '';
      if (!/^[0-9A-F]+\/[0-9A-F]+$/i.test(sourceLsn)) {
        send(500, { success: false, error: `could not capture the source end-of-WAL: ${lsn.stderr.trim().split('\n').pop() || 'empty output'}` });
        return;
      }
      send(200, { success: true, sourceLsn });
      return;
    }
    if (action === 'teardown') {
      // Swap teardown (RC-4): the receiver has promoted and no longer needs
      // this side. Answer FIRST - the response still rides the tunnel the
      // disarm below tears down - then disarm this side exactly like the
      // operator's button would (helpers removed, slot dropped, record
      // cleared). Best effort by design: if it fails, the source operator
      // disarms manually during the handback visit.
      send(200, { success: true });
      setTimeout(() => {
        void (async () => {
          const { disarmRecoveryChannel } = await import('./recoveryChannel');
          const fresh = containerManager.getBot(instance.id);
          if (!fresh?.recoveryChannel) return;
          const disarmed = await disarmRecoveryChannel(fresh);
          console.log(disarmed.success
            ? `[RecoveryControl] Source side disarmed after the swap (${fresh.displayName})`
            : `[RecoveryControl] Source-side disarm after the swap failed (${fresh.displayName}): ${disarmed.error}`);
        })();
      }, 2_000).unref();
      return;
    }
  } catch (err) {
    send(500, { success: false, error: err instanceof Error ? err.message : String(err) });
  }
}

/** Idempotent; called at arm time and boot. The server is harmless while no source record exists (every route re-checks the record + token). */
export function startRecoveryControlServer(): void {
  if (server) return;
  server = http.createServer((req, res) => { void handle(req, res); });
  server.on('error', err => console.warn(`[RecoveryControl] server error: ${err.message}`));
  server.listen(RECOVERY_CONTROL_PORT, () => console.log(`[RecoveryControl] listening on :${RECOVERY_CONTROL_PORT} (docker networks only)`));
}

export function stopRecoveryControlServer(): void {
  server?.close();
  server = null;
  for (const [, session] of sessions) session.child.kill();
  sessions.clear();
}
