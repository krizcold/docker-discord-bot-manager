/**
 * Moving the main off a machine without an open port: Receive on the server (a time-limited login and a move code),
 * Push from the main (dump, replace the receiver's database, compare counts and checksums, raise its generation),
 * and the move by file (a backup downloaded here and uploaded in the other manager).
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { Request } from 'express';
import * as containerManager from '../docker/containerManager';
import * as fleetBackup from './fleetBackup';
import * as fleetJoin from './fleetJoin';
import * as fleetReplica from './fleetReplica';
import * as maintenance from './maintenance';
import { addressTableSql, getJoinCode, REPLICATION_ROLE } from './fleetReplication';
import { claimFleetBackupBusy, releaseFleetBackupBusy } from './fleetBackupGuards';
import { MANAGER_DB_ROLE } from './dbLogin';
import {
  backupDir, CHECKSUM_SQL, compareChecksums, compareCounts, COUNTS_SQL, parseChecksumLines, parseCountLines, utcText, validateDumpMeta,
} from './backupFiles';
import { decodeJoinCode, decodeMoveCode, encodeJoinCode, encodeMoveCode, MoveCode, sqlLiteral } from '../config/joinCode';
import {
  copiesInsertSql, DB_OID_SQL, GEN_READ_SQL, machineNameOf, markIdOf, missingTable, OWN_COPIES_READ_SQL, parseGenRow, pushBrokenOf, raiseSql, RECEIVE_DROP_SQL,
  RECEIVE_END_SQL, RECEIVE_NOLOGIN_SQL, RECEIVED_OF_SQL, receiveMarkClearSql, receiveMarkSql, replicationRoleEnsureSql, SHARD_CAP_DO_SQL,
} from './switchSql';
import {
  adminSql, LaneOutcome, mainAdmission, noticeRefusal, ownGeneration, provenMaintenance, runGuarded, runLane, setReceiveStep,
  switchAdmissionNotice,
} from './fleetSwitch';
import { FleetDbReceive, InstanceConfig, JoinAddress } from '../types';

export const MOVE_TIMING = { receiveForMs: 24 * 60 * 60_000, clientMs: 60_000, pushMs: 30 * 60_000, verifyMs: 10 * 60_000, sessionPauseMs: 1_000, endRounds: 3 };
export const RECEIVE_ROLE = 'smdb_receive';
const MIN_FREE_BYTES = 512 * 1024 * 1024;
const NOTHING = '; nothing was changed';
const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));
const lastLine = (text: string) => text.trim().split('\n').map(l => l.trim()).filter(Boolean).pop() || 'no reason given';
const refusal = (text: string, status = 409): LaneOutcome => ({ success: false, text, status });
const SLOT_BUSY = `A backup or restore operation is in progress on this database; wait for it to finish${NOTHING}`;
const NAME: Record<string, string> = { running: 'Running', maintenance: 'Maintenance', off: 'Off' };

function saveSwitch(botId: string, patch: Parameters<typeof containerManager.updateInstanceFleetDbSwitch>[1]): string | null {
  try {
    containerManager.updateInstanceFleetDbSwitch(botId, patch);
    return null;
  } catch (err) {
    return errText(err);
  }
}

function claimSlot(botId: string): LaneOutcome | null {
  if (claimFleetBackupBusy(botId)) return null;
  return containerManager.isShuttingDown() ? refusal(containerManager.SHUTDOWN_REFUSAL, 503) : refusal(SLOT_BUSY);
}

// ─── O5 Receive ───

const roleScript = (password: string, expires: string) => `DO $$ BEGIN
IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${RECEIVE_ROLE}') THEN
  ALTER ROLE ${RECEIVE_ROLE} LOGIN SUPERUSER PASSWORD ${sqlLiteral(password)} VALID UNTIL ${sqlLiteral(expires)};
ELSE
  CREATE ROLE ${RECEIVE_ROLE} LOGIN SUPERUSER PASSWORD ${sqlLiteral(password)} VALID UNTIL ${sqlLiteral(expires)};
END IF;
END $$;`;

type Failed = { ok: false; error: string };
const failed = (r: { error?: string; stderr: string }): Failed => ({ ok: false, error: r.error || lastLine(r.stderr) });

/** D54: the receive login takes no new session, its sessions are ended and counted to 0, then it is dropped. */
async function endReceiveLogin(inst: InstanceConfig): Promise<{ ok: true } | { ok: false; left?: number; error: string }> {
  const db = inst.fleetDb!;
  const t = { container: db.containerName, user: db.user };
  const nologin = await adminSql(t, 'postgres', RECEIVE_NOLOGIN_SQL);
  if (!nologin.ok) return failed(nologin);
  let left = 0;
  for (let round = 1; round <= MOVE_TIMING.endRounds; round++) {
    if (round > 1) await new Promise(r => setTimeout(r, MOVE_TIMING.sessionPauseMs));
    const ended = await adminSql(t, 'postgres', RECEIVE_END_SQL);
    if (!ended.ok) return failed(ended);
    left = Number(ended.stdout.trim().split('\n').pop()?.trim() ?? '');
    if (!Number.isInteger(left)) return { ok: false, error: 'the count of its sessions did not read' };
    if (left === 0) break;
  }
  if (left > 0) return { ok: false, left, error: `${left} session(s) did not end` };
  const drop = await adminSql(t, 'postgres', RECEIVE_DROP_SQL);
  return drop.ok ? { ok: true } : failed(drop);
}

/** A psql error that says the bot database or an smdb_manager table is missing: no push committed into it. */
const noRow = (stderr: string) => missingTable(stderr) || /database "[^"]*" does not exist/.test(stderr);

/** The newest received row of the mark's ids (D53) as `<machine>|<generation>`, '' for none. */
async function receivedLine(inst: InstanceConfig, r: FleetDbReceive): Promise<{ ok: true; line: string } | Failed> {
  const db = inst.fleetDb!;
  const got = await adminSql({ container: db.containerName, user: db.user }, db.db, RECEIVED_OF_SQL([r.pushId, ...(r.priorIds ?? [])]));
  if (!got.ok) return noRow(got.stderr) ? { ok: true, line: '' } : failed(got);
  return { ok: true, line: got.stdout.trim() };
}

/** D42: whether a push replaced this database (another oid, or none) and wrote no received row of the mark's ids. */
async function pushCheck(inst: InstanceConfig): Promise<{ ok: true; broken: boolean; done: string | null } | Failed> {
  const db = inst.fleetDb!;
  const r = db.receive!;
  const oid = await adminSql({ container: db.containerName, user: db.user }, 'postgres', DB_OID_SQL(db.db));
  if (!oid.ok) return failed(oid);
  const oidNow = oid.stdout.trim();
  let done: string | null = null;
  if (oidNow) {
    const got = await receivedLine(inst, r);
    if (!got.ok) return got;
    done = got.line || null;
  }
  return { ok: true, broken: pushBrokenOf(r.dbOid, oidNow, done !== null), done };
}

/** The sessions count last logged per bot (RV-LOG-SESS once per change); cleared when the receive ends. */
const sessionsLogged = new Map<string, number>();

/** D51: a push of the mark finished: the copies written back, the login ended, receive and pushBroken cleared in one save. */
async function finishReceive(inst: InstanceConfig, r: FleetDbReceive, line: string): Promise<{ ok: true; machine: string; generation: string } | { ok: false; error: string; saveFailed?: boolean }> {
  const db = inst.fleetDb!;
  if (r.copies?.length) {
    const back = await adminSql({ container: db.containerName, user: db.user }, db.db, copiesInsertSql(r.copies));
    if (!back.ok) console.warn(`[Switch] ${inst.displayName}: this machine's copies could not be listed again after the push (${back.error || lastLine(back.stderr)}); they register again within an hour`);
  }
  const ended = await endReceiveLogin(inst);
  if (!ended.ok) return { ok: false, error: ended.error };
  const saved = saveSwitch(inst.id, { receive: null, pushBroken: null });
  if (saved) return { ok: false, error: saved, saveFailed: true };
  await clearMarkLogged(inst, markIdOf(r));
  sessionsLogged.delete(inst.id);
  containerManager.broadcastBotUpdated(inst.id);
  const [machine, generation] = line.split('|');
  console.log(`[Switch] ${inst.displayName}: received the main from ${machine} (generation ${generation}); the receive login is removed`);
  return { ok: true, machine, generation };
}

const STOP_FAIL = (error: string) => refusal(`The receive login could not be removed (${error}); try again.`, 500);
const NOT_MARKED = (error: string) => refusal(`The receive login was removed, but receiving could not be marked stopped (${error}); try again.`, 500);
const brokenMark = (r: FleetDbReceive, at: string) => ({ at, safetyDump: r.safetyDump, ...(r.copies ? { copies: r.copies } : {}) });

/** This machine's copy rows whose slots exist, written back after a push (D49); empty when they cannot be read. */
async function ownCopies(inst: InstanceConfig): Promise<JoinAddress[]> {
  const db = inst.fleetDb!;
  const r = await adminSql({ container: db.containerName, user: db.user }, db.db, OWN_COPIES_READ_SQL);
  return r.ok ? fleetJoin.parseAddressRows(r.stdout) : [];
}

/** D62: the receive mark row of this mark id removed from the cluster's postgres database; the error, or null. */
async function clearMark(inst: InstanceConfig, markId: string): Promise<string | null> {
  const db = inst.fleetDb!;
  const r = await adminSql({ container: db.containerName, user: db.user }, 'postgres', receiveMarkClearSql(markId));
  return r.ok ? null : failed(r).error;
}

async function clearMarkLogged(inst: InstanceConfig, markId: string): Promise<void> {
  const error = await clearMark(inst, markId);
  if (error) console.warn(`[Switch] ${inst.displayName}: the mark that tells this database's copies it is receiving could not be removed (${error}); the manager tries again every minute`);
}

export async function receiveMain(botId: string): Promise<LaneOutcome> {
  const inst = containerManager.getBot(botId);
  if (!inst) return refusal('Bot not found', 404);
  const db = inst.fleetDb;
  if (!db || db.retiringAt) return refusal(`This instance holds no main database to replace; install it with a blank Database URL first${NOTHING}`);
  if (!db.replication) return refusal(`Replication is not enabled, so the other machine has no address to push to; enable it first${NOTHING}`);
  const prior = db.receive;
  if (!prior) {
    const admission = mainAdmission(inst, { replication: true, noun: 'replace', allowPushBroken: true });
    if (admission) return refusal(admission);
  }
  if (noticeRefusal(botId, 'receiving was refused')) {
    return refusal(`Receiving was refused and nothing was changed: a restore of ${fleetBackup.shownRestoreNoticeFile(botId)} has not finished cleanly here (its notice is on the Database window), and a push would replace the database that notice is about. Dismiss the notice, or restore a dump again, then press Receive.`);
  }
  const rec = maintenance.maintenanceOf(inst);
  if (rec.state !== 'off' || !rec.settled) {
    return refusal(`Receiving replaces this machine's database, so the bot must be Off first (its state is ${NAME[rec.state]}${rec.settled ? '' : ', not confirmed'}); choose Off in the State window${NOTHING}`);
  }
  const proof = await maintenance.requireMaintenance(botId, 'database');
  if (!proof.ok) return refusal(`Receiving was refused and nothing was changed: ${proof.error}`);
  const fence = await switchAdmissionNotice(botId, 'receiving was refused', { skipNotice: true });
  if (fence) return refusal(fence);
  const t = { container: db.containerName, user: db.user };
  const ensured = await adminSql(t, 'postgres', replicationRoleEnsureSql(REPLICATION_ROLE));
  if (!ensured.ok) return refusal(`The manager could not make sure the replication role exists in this database's cluster (${failed(ensured).error}), and a pushed database that grants to it would not restore${NOTHING}`, 500);

  if (prior) {
    const got = await receivedLine(inst, prior);
    if (!got.ok) return refusal(`The manager could not read whether a push with the current move code already finished (${got.error}), so no new move code was made${NOTHING}`, 500);
    if (got.line) {
      const done = await finishReceive(inst, prior, got.line);
      if (!done.ok) return done.saveFailed ? NOT_MARKED(done.error) : STOP_FAIL(done.error);
      return { success: true, text: `The push from ${done.machine} had already finished (generation ${done.generation}), so this database is the main now; receiving ended and no new move code was made.` };
    }
  }

  const broken = db.pushBroken;
  let safetyDump = prior?.safetyDump ?? '';
  let dbOid = prior?.dbOid ?? '';
  let copies = prior?.copies ?? [];
  if (!prior) {
    if (broken) {
      safetyDump = broken.safetyDump;
    } else {
      const slot = claimSlot(botId);
      if (slot) return slot;
      try {
        const dump = await fleetBackup.runFleetDump(inst, 'pre-receive-');
        if (!dump.success || !dump.file) return refusal(`The dump of this database failed (${dump.error || 'no reason given'}), so nothing was changed`);
        safetyDump = dump.file;
      } finally {
        releaseFleetBackupBusy(botId);
      }
    }
    const oid = await adminSql(t, 'postgres', DB_OID_SQL(db.db));
    if (!oid.ok || (!broken && !oid.stdout.trim())) {
      const error = oid.ok ? 'the database is missing' : failed(oid).error;
      return refusal(`The manager could not read this database's identity before receiving (${error}), so it could not tell later whether a push replaced it; the dump ${safetyDump} was kept and nothing else was changed`, 500);
    }
    dbOid = oid.stdout.trim();
    copies = broken?.copies ?? await ownCopies(inst);
  }
  const join = await getJoinCode(containerManager.getBot(botId) ?? inst);
  const decoded = join.success && join.joinCode ? decodeJoinCode(join.joinCode) : null;
  if (!decoded || !decoded.ok) {
    const error = join.success ? 'the join code did not decode' : join.error || 'the join code did not decode';
    if (prior) return refusal(`The move code could not be made (${error}), so no new move code was made; the code shown before still works until ${utcText(Date.parse(prior.expiresAt))}.`, 500);
    return refusal(`The move code could not be made (${error}); the dump ${safetyDump} was kept and nothing else was changed`, 500);
  }
  const startedAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + MOVE_TIMING.receiveForMs).toISOString();
  const pushId = crypto.randomBytes(12).toString('hex');
  const priorIds = prior ? [...(prior.priorIds ?? []), prior.pushId] : [];
  const marked = saveSwitch(botId, { receive: { startedAt: prior?.startedAt ?? startedAt, expiresAt, safetyDump, pushId, priorIds, dbOid, copies } });
  if (marked) return refusal(`Receiving could not be recorded (${marked}); the dump ${safetyDump} was kept and nothing else was changed`, 500);
  const backTail = (back: string | null) => (back ? ` The manager could not put the earlier record back (${back}); a push made with the earlier code is still recognised.` : '');
  const unrecTail = (back: string) => `. The manager could not clear its record of receiving (${back}); press Stop receiving.`;
  const written = await adminSql(t, 'postgres', receiveMarkSql(priorIds[0] ?? pushId, [...priorIds, pushId], broken ? '' : dbOid));
  if (!written.ok) {
    const error = failed(written).error;
    const back = saveSwitch(botId, { receive: prior ?? null });
    if (prior) return refusal(`The manager could not write the new move code's id into the mark that tells this database's copies a push may replace it (${error}), so no new move code was made; the code shown before still works until ${utcText(Date.parse(prior.expiresAt))}.${backTail(back)}`, 500);
    const lead = `Receiving was not started: the manager could not write the mark that tells this database's copies a push may replace it (${error}). The dump ${safetyDump} was kept`;
    return refusal(back ? `${lead}${unrecTail(back)}` : `${lead}; nothing else was changed.`, 500);
  }
  const password = crypto.randomBytes(24).toString('base64url');
  const role = await adminSql(t, 'postgres', roleScript(password, expiresAt));
  if (!role.ok) {
    const error = failed(role).error;
    if (!prior) {
      const lead = `The receive login could not be created (${error})`;
      const back = saveSwitch(botId, { receive: null });
      if (back) return refusal(`${lead}${unrecTail(back)}`, 500);
      const left = broken ? null : await clearMark(inst, pushId);
      if (left) return refusal(`${lead}. The mark that tells this database's copies a push may replace it could not be removed (${left}); the manager removes it within a minute.`, 500);
      return refusal(`${lead}; nothing else was changed`, 500);
    }
    const back = saveSwitch(botId, { receive: prior });
    return refusal(`The receive login could not be changed (${error}), so no new move code was made; the code shown before still works until ${utcText(Date.parse(prior.expiresAt))}.${backTail(back)}`, 500);
  }
  const moveCode = encodeMoveCode({ ...decoded.code, recv: { user: RECEIVE_ROLE, password, id: pushId } });
  const text = broken
    ? `Paste this move code into Push the main in the other machine's manager within 24 hours. It replaces this machine's database with the pushed one. This database holds a push that did not finish, so no new dump was taken; the dump ${safetyDump}, taken before that push, stays with the backups. The code holds passwords: paste it only into your own managers.`
    : `Paste this move code into Push the main in the other machine's manager within 24 hours. It replaces this machine's database with the pushed one; a dump of this one is kept with the backups (${safetyDump}). The code holds passwords: paste it only into your own managers.`;
  return { success: true, moveCode, text };
}

export async function stopReceiving(botId: string): Promise<LaneOutcome> {
  const inst = containerManager.getBot(botId);
  if (!inst?.fleetDb) return refusal('Bot not found', 404);
  const r = inst.fleetDb.receive;
  if (!r) return refusal('This database is not waiting to receive a main');
  const ended = await endReceiveLogin(inst);
  if (!ended.ok) {
    if (ended.left !== undefined) return refusal(`The receive login no longer accepts new sessions, but ${ended.left} of its session(s) did not end after three tries, so receiving was not stopped; press Stop receiving again.`, 500);
    return STOP_FAIL(ended.error);
  }
  const check = await pushCheck(inst);
  if (!check.ok) return refusal(`The receive login was removed, so the move code no longer works, but the manager could not read whether a push replaced this database (${check.error}), so receiving stays recorded; press Stop receiving again.`, 500);
  if (check.done) {
    const done = await finishReceive(inst, r, check.done);
    if (!done.ok) return done.saveFailed ? NOT_MARKED(done.error) : STOP_FAIL(done.error);
    return { success: true, text: `Receiving stopped: the push from ${done.machine} had already finished (generation ${done.generation}), so this database is the main now. The move code no longer works.` };
  }
  const cleared = saveSwitch(botId, { receive: null, ...(check.broken ? { pushBroken: brokenMark(r, new Date().toISOString()) } : {}) });
  if (cleared) return NOT_MARKED(cleared);
  sessionsLogged.delete(botId);
  const still = containerManager.getBot(botId)?.fleetDb?.pushBroken;
  if (!check.broken && !still) await clearMarkLogged(inst, markIdOf(r));
  if (check.broken) return { success: true, text: `Receiving stopped; the move code no longer works. A push replaced this machine's database and did not finish, so the database is empty or holds data that was not checked, and the bot cannot run on it: restore the dump ${r.safetyDump} (taken before receiving) with the bot in Maintenance or Off, or press Receive again so the other machine can push again.` };
  const tail = still ? ` A push that did not finish earlier still stands: restore the dump ${still.safetyDump} (taken before that push) with the bot in Maintenance or Off, or press Receive again.` : '';
  return { success: true, text: `Receiving stopped; the move code no longer works.${tail}` };
}

/** N-c: a push that committed, or a code that expired unused, ends receiving. */
export async function receiveStep(inst: InstanceConfig, now: number): Promise<void> {
  const db = inst.fleetDb;
  const r = db?.receive;
  if (!db || !r) return;
  const got = await receivedLine(inst, r);
  if (got.ok && got.line) {
    await finishReceive(inst, r, got.line);
    return;
  }
  if (now < Date.parse(r.expiresAt)) return;
  const ended = await endReceiveLogin(inst);
  if (!ended.ok) {
    if (ended.left !== undefined && sessionsLogged.get(inst.id) !== ended.left) {
      sessionsLogged.set(inst.id, ended.left);
      console.log(`[Switch] ${inst.displayName}: the move code expired, but ${ended.left} session(s) of the receive login did not end; the manager tries again every minute`);
    }
    return;
  }
  const check = await pushCheck(inst);
  if (!check.ok) return;
  if (check.done) {
    await finishReceive(inst, r, check.done);
    return;
  }
  if (saveSwitch(inst.id, { receive: null, ...(check.broken ? { pushBroken: brokenMark(r, new Date(now).toISOString()) } : {}) })) return;
  if (!check.broken && !containerManager.getBot(inst.id)?.fleetDb?.pushBroken) await clearMarkLogged(inst, markIdOf(r));
  sessionsLogged.delete(inst.id);
  containerManager.broadcastBotUpdated(inst.id);
  console.log(check.broken
    ? `[Switch] ${inst.displayName}: the move code expired; a push replaced this database and did not finish, so the bot stays stopped until the dump ${r.safetyDump} is restored or a push finishes; the receive login is removed`
    : `[Switch] ${inst.displayName}: the move code expired unused; the receive login is removed`);
}

setReceiveStep(receiveStep);

// ─── O6 Push ───

function recvDsn(code: MoveCode, db: string): string {
  return `postgresql://${encodeURIComponent(code.recv.user)}@${code.host}:${code.port}/${db}?sslmode=verify-full&sslrootcert=/primary-ca.crt`;
}

/** psql against the receiver as the receive login, in a throwaway client container; input streams a file when given. */
async function receiverClient(inst: InstanceConfig, code: MoveCode, pem: string, suffix: string, script: string, args: string[], timeoutMs: number, inputPath?: string) {
  const mount = `${fleetJoin.ensureProbeCert(inst.id, code.fp, pem)}:/primary-ca.crt:ro`;
  const name = `${inst.sanitizedName}-fleet-move-${suffix}`;
  await runGuarded('docker', ['rm', '-f', name], { timeoutMs: 30_000 });
  const r = await runGuarded('docker', ['run', '--rm', ...(inputPath ? ['-i'] : []), '--name', name, '-e', 'PGPASSWORD', '-v', mount, '--entrypoint', 'sh', 'postgres:16-alpine', '-c', script, 'sh', ...args],
    { timeoutMs, env: { ...process.env, PGPASSWORD: code.recv.password }, ...(inputPath ? { inputPath } : {}) });
  if (!r.ok && r.code === null) await runGuarded('docker', ['rm', '-f', name], { timeoutMs: 30_000 });
  const scrub = (s: string) => s.split(code.recv.password).join('***');
  return { ...r, stderr: scrub(r.stderr), error: r.error ? scrub(r.error) : r.error };
}

const LOGIN_RE = /password authentication failed|pg_hba\.conf rejects connection|no pg_hba\.conf entry|is not permitted to log in|role "[^"]*" does not exist|VALID UNTIL|expired/i;

export async function pushMain(botId: string, moveCode: string, confirm: boolean, admit: () => void = () => undefined): Promise<LaneOutcome> {
  const inst = containerManager.getBot(botId);
  if (!inst) return refusal('Bot not found', 404);
  const decoded = decodeMoveCode(moveCode);
  if (!decoded.ok) return refusal(`This is not a move code: ${decoded.why}`, 400);
  const code = decoded.code;
  const resume = (h: NonNullable<NonNullable<InstanceConfig['fleetDb']>['handover']>) => h.mode === 'push' && h.host === code.host && h.port === code.port;
  const admission = mainAdmission(inst, { replication: false, noun: 'push', resume });
  if (admission) return refusal(admission);
  const db = inst.fleetDb!;
  const repl = db.replication;
  if (repl && repl.publicHost.toLowerCase() === code.host.toLowerCase() && repl.hostPort === code.port) return refusal(`That move code is for this machine's own database${NOTHING}`);
  if (code.app.user !== db.user) return refusal(`The other machine's database role is ${code.app.user}, not ${db.user}, so the pushed tables would have no owner there${NOTHING}`);
  const notice = noticeRefusal(botId, 'the push was refused');
  if (notice) return refusal(notice);
  const proven = await provenMaintenance(botId, 'push', confirm);
  if (proven) return proven;
  const slot = claimSlot(botId);
  if (slot) return slot;
  let outcome: LaneOutcome;
  let safetyDump = '';
  let stopped = true;
  try {
    const r = await pushLocked(inst, code, admit);
    outcome = r.outcome;
    safetyDump = r.safetyDump;
    stopped = r.stopped !== false;
  } finally {
    releaseFleetBackupBusy(botId);
  }
  if (!outcome.success || !stopped) return outcome;
  const first = outcome;
  return {
    ...first,
    after: async () => {
      const fresh = containerManager.getBot(botId);
      if (!fresh) return first;
      const joinText = encodeJoinCode({ v: 1, host: code.host, port: code.port, db: code.db, fp: code.fp, machine: code.machine, repl: code.repl, app: code.app });
      const re = fleetReplica.reseedStalePrimary(fresh, joinText, fresh.fleetDb?.replication?.publicHost, fresh.fleetDb?.replication?.hostPort, false, { dumpDone: !!safetyDump, ...(safetyDump ? { safetyDump } : {}) });
      return re.success ? first : { ...first, text: `${first.text} Rejoining as a copy did not start: ${re.error}; press Rejoin as a copy.` };
    },
  };
}

async function pushLocked(inst: InstanceConfig, code: MoveCode, admit: () => void): Promise<{ outcome: LaneOutcome; safetyDump: string; stopped?: boolean }> {
  const botId = inst.id;
  const db = inst.fleetDb!;
  const t = { container: db.containerName, user: db.user };
  const machine = code.machine;
  const where = `${code.host}:${code.port}`;
  const out = (outcome: LaneOutcome, safetyDump = '') => ({ outcome, safetyDump });
  const cert = await fleetJoin.mainCertificate(code);
  if (!cert.ok) return out(refusal(cert.text));
  const pulled = await fleetJoin.ensureClientImage();
  if (pulled) return out(refusal(`${pulled}${NOTHING}`));
  const sys = await adminSql(t, db.db, 'SELECT system_identifier FROM pg_control_system();');
  if (!sys.ok) return out(refusal(`The manager could not read this database's identity (${sys.error || lastLine(sys.stderr)})${NOTHING}`));
  const systemId = lastLine(sys.stdout);
  const probeScript = 'psql "$1" -v ON_ERROR_STOP=1 -Atc "SELECT pg_is_in_recovery()::text" || exit 2; '
    + 'psql "$2" -v ON_ERROR_STOP=1 -Atc "$3" 2>/tmp/g.err || { if grep -q "does not exist" /tmp/g.err; then echo "0||"; else cat /tmp/g.err >&2; exit 3; fi; }; '
    + 'psql "$2" -v ON_ERROR_STOP=1 -Atc "$4" 2>/tmp/r.err || { if grep -q "does not exist" /tmp/r.err; then echo "0"; else cat /tmp/r.err >&2; exit 4; fi; }';
  const probe = await receiverClient(inst, code, cert.pem, 'probe', probeScript,
    [recvDsn(code, 'postgres'), recvDsn(code, code.db), GEN_READ_SQL, `SELECT count(*) FROM smdb_manager.received WHERE push_id = ${sqlLiteral(code.recv.id)}`], MOVE_TIMING.clientMs);
  if (!probe.ok) {
    const reason = (probe.stderr.trim() ? lastLine(probe.stderr) : '') || probe.error || 'no answer';
    if (LOGIN_RE.test(probe.stderr)) return out(refusal(`${where} refused the move code's login (${reason}): the code expired, receiving was stopped, a newer code replaced it, or a lane on that machine holds a write fence on its database. Check that machine's Database window, then press Receive again there; nothing was changed.`));
    return out(refusal(`${where} did not answer the move code's login (${reason})${NOTHING}`));
  }
  const lines = probe.stdout.trim().split('\n').map(l => l.trim());
  if (lines[0] === 'true') return out(refusal(`The database at ${where} follows another database, so it cannot receive a main${NOTHING}`));
  const theirGen = parseGenRow(lines[1] ?? '') ?? null;
  const already = (lines[2] ?? '0') !== '0';
  if (already) {
    // P23: "already received" is trusted only with this machine's own push mark for that address and its dump on disk.
    const mark = db.handover?.mode === 'push' && db.handover.host === code.host && db.handover.port === code.port ? db.handover : null;
    const onDisk = !!mark?.file && fs.existsSync(path.join(backupDir(botId), mark.file));
    if (!onDisk) {
      const why = mark?.file ? `the dump this machine made for it, ${mark.file}, is no longer on disk` : 'this machine has no record of making it';
      return out(refusal(`${where} already holds the push made with this move code, and ${why}, so nothing was pushed or changed here. If this database should move there, press Receive again on that machine and push with the new move code.`));
    }
  }
  const own = await ownGeneration(t, db.db);
  if (!own.ok) return out(refusal(`The manager could not read this database's generation (${own.error})${NOTHING}`));
  const target = Math.max(own.row?.generation ?? 0, theirGen?.generation ?? 0) + 1;

  let file = db.handover?.mode === 'push' ? db.handover.file ?? '' : '';
  if (!already) {
    const dump = await fleetBackup.runFleetDump(inst, 'pre-push-');
    if (!dump.success || !dump.file) return out(refusal(`The dump of this database failed (${dump.error || 'no reason given'}), so nothing was pushed`));
    file = dump.file;
    const marked = saveSwitch(botId, { handover: { mode: 'push', machine, host: code.host, port: code.port, generation: target, file, phase: 'pushing', at: new Date().toISOString() } });
    if (marked) return out(refusal(`The push could not be recorded (${marked}); the dump ${file} was kept and nothing was pushed`, 500), file);
    admit();
    const fail = (text: string) => {
      saveSwitch(botId, { handover: { ...containerManager.getBot(botId)!.fleetDb!.handover!, lastError: text } });
      return out(refusal(text, 500), file);
    };
    const dumpPath = path.join(backupDir(botId), file);
    const dbIdent = `"${code.db.replace(/"/g, '""')}"`;
    const userIdent = `"${db.user.replace(/"/g, '""')}"`;
    const pushScript = `psql "$1" -v ON_ERROR_STOP=1 -c 'DROP DATABASE IF EXISTS ${dbIdent.replace(/'/g, "'\\''")} WITH (FORCE)' -c 'CREATE DATABASE ${dbIdent.replace(/'/g, "'\\''")} OWNER ${userIdent.replace(/'/g, "'\\''")}' && pg_restore --exit-on-error --single-transaction -d "$2"`;
    const pushed = await receiverClient(inst, code, cert.pem, 'push', pushScript, [recvDsn(code, 'postgres'), recvDsn(code, code.db)], MOVE_TIMING.pushMs, dumpPath);
    if (!pushed.ok) {
      return fail(`The push to ${machine} failed (${pushed.error || lastLine(pushed.stderr)}). This machine's database is unchanged; ${machine}'s database is incomplete, and its bot stays Off. Press Push again with the same code, or Cancel the push.`);
    }
    let meta;
    try {
      const parsed = validateDumpMeta(JSON.parse(fs.readFileSync(`${dumpPath}.json`, 'utf-8')));
      if (!parsed.ok) throw new Error(parsed.error);
      meta = parsed.meta;
    } catch (err) {
      return fail(`The pushed copy on ${machine} does not match this database (the counts could not be read (${errText(err)})), so ${machine} was not made the main. Press Push again, or Cancel the push.`);
    }
    const counts = await receiverClient(inst, code, cert.pem, 'counts', 'psql "$1" -v ON_ERROR_STOP=1 -Atc "$2"', [recvDsn(code, code.db), COUNTS_SQL], MOVE_TIMING.verifyMs);
    const theirCounts = counts.ok ? parseCountLines(counts.stdout) : null;
    if (!theirCounts || !theirCounts.ok) {
      const why = !counts.ok ? counts.error || lastLine(counts.stderr) : theirCounts && !theirCounts.ok ? theirCounts.error : 'no answer';
      return fail(`The pushed copy on ${machine} does not match this database (the counts could not be read (${why})), so ${machine} was not made the main. Press Push again, or Cancel the push.`);
    }
    const cmp = compareCounts(meta.counts, theirCounts.counts);
    if (!cmp.ok) return fail(`The pushed copy on ${machine} does not match this database (counts: ${cmp.text}), so ${machine} was not made the main. Press Push again, or Cancel the push.`);
    const sums = await checksumsOf(t, db.db);
    const theirSums = await receiverClient(inst, code, cert.pem, 'sums', 'psql "$1" -v ON_ERROR_STOP=1 -Atc "$2"', [recvDsn(code, code.db), CHECKSUM_SQL], MOVE_TIMING.verifyMs);
    const parsedTheirs = theirSums.ok ? parseChecksumLines(theirSums.stdout) : null;
    if (!sums.ok || !parsedTheirs || !parsedTheirs.ok) {
      const why = !sums.ok ? sums.error : !theirSums.ok ? theirSums.error || lastLine(theirSums.stderr) : parsedTheirs && !parsedTheirs.ok ? parsedTheirs.error : 'no answer';
      return fail(`The pushed copy on ${machine} does not match this database (the checksums could not be read (${why})), so ${machine} was not made the main. Press Push again, or Cancel the push.`);
    }
    const sumCmp = compareChecksums(sums.sums, parsedTheirs.sums);
    if (!sumCmp.ok) return fail(`The pushed copy on ${machine} does not match this database (checksums: ${sumCmp.text}), so ${machine} was not made the main. Press Push again, or Cancel the push.`);

    const commit = `SET ROLE ${MANAGER_DB_ROLE};\n${raiseSql(code.machine, target, `${addressTableSql(code.host, code.port, cert.pem, code.machine, null)}
DELETE FROM smdb_manager.addresses WHERE NOT (host = ${sqlLiteral(code.host)} AND port = ${Number(code.port)});
INSERT INTO smdb_manager.received (push_id, from_system_id, from_machine, generation) VALUES (${sqlLiteral(code.recv.id)}, ${sqlLiteral(systemId)}, ${sqlLiteral(machineNameOf(inst))}, ${target}) ON CONFLICT (push_id) DO NOTHING;
${SHARD_CAP_DO_SQL}`)}`;
    const committed = await receiverClient(inst, code, cert.pem, 'commit', 'psql "$1" -v ON_ERROR_STOP=1 -tAq -c "$2"', [recvDsn(code, code.db), commit], MOVE_TIMING.clientMs);
    if (!committed.ok) return fail(`The data reached ${machine} and matched, but ${machine} could not be made the main (${committed.error || lastLine(committed.stderr)}). Press Push again.`);
  } else {
    admit();
  }
  const prior = containerManager.getBot(botId)?.fleetDb?.handover;
  const { lastError: _cleared, ...kept } = prior?.mode === 'push' ? prior : { mode: 'push' as const, machine, host: code.host, port: code.port, generation: target, file, at: new Date().toISOString(), phase: 'pushing' as const, lastError: undefined };
  const doneError = saveSwitch(botId, { handover: { ...kept, phase: 'done' } });
  const meta = file ? readMeta(path.join(backupDir(botId), file)) : null;
  const checked = meta ? `${meta.tables} tables and ${meta.rows} rows` : 'every table';
  let text = `The database was pushed to ${machine} and checked: ${checked}, with the same counts and checksums on both.`;
  text += ` ${machine} is the main now (generation ${target}); choose Running in its State window to start the bot there. This machine now rebuilds itself as a copy of ${machine}; a dump of its database from before the push is kept with the backups (${file || 'none'}).`;
  if (doneError) text += ` The manager could not record this (${doneError}); press the same button again to finish recording it.`;
  let stopped = true;
  if (await containerManager.appContainerRunning(botId) === true) {
    const stop = await containerManager.stopBotInOp(botId, 'push');
    if (!stop.success && stop.error !== 'Bot is not running') {
      stopped = false;
      text += ` The bot here did not stop (${stop.error}); stop it, then press Rejoin as a copy.`;
    }
  }
  console.log(`[Switch] ${inst.displayName}: pushed the main to ${machine} (generation ${target})`);
  return { outcome: { success: true, text }, safetyDump: file, stopped };
}

function readMeta(dumpPath: string) {
  try {
    const parsed = validateDumpMeta(JSON.parse(fs.readFileSync(`${dumpPath}.json`, 'utf-8')));
    return parsed.ok ? parsed.meta : null;
  } catch {
    return null;
  }
}

/** The checksum of every table of this database, read here. */
export async function checksumsOf(t: { container: string; user: string }, db: string): Promise<{ ok: true; sums: Record<string, string> } | { ok: false; error: string }> {
  const r = await adminSql(t, db, `${CHECKSUM_SQL};`, MOVE_TIMING.verifyMs);
  if (!r.ok) return { ok: false, error: r.error || lastLine(r.stderr) };
  const parsed = parseChecksumLines(r.stdout);
  return parsed.ok ? parsed : { ok: false, error: parsed.error };
}

// ─── O7 Move out by file ───

export async function moveOut(botId: string, confirm: boolean): Promise<LaneOutcome> {
  const inst = containerManager.getBot(botId);
  if (!inst) return refusal('Bot not found', 404);
  const admission = mainAdmission(inst, { replication: false, noun: 'move' });
  if (admission) return refusal(admission);
  const notice = noticeRefusal(botId, 'the move was refused');
  if (notice) return refusal(notice);
  const proven = await provenMaintenance(botId, 'move', confirm);
  if (proven) return proven;
  const slot = claimSlot(botId);
  if (slot) return slot;
  let file: string;
  try {
    const dump = await fleetBackup.runFleetDump(inst, 'pre-move-');
    if (!dump.success || !dump.file) return refusal(`The dump failed (${dump.error || 'no reason given'}), so nothing was changed`, 500);
    file = dump.file;
  } finally {
    releaseFleetBackupBusy(botId);
  }
  const marked = saveSwitch(botId, { handover: { mode: 'file', file, phase: 'done', at: new Date().toISOString() } });
  if (marked) return refusal(`The move could not be recorded (${marked}); the dump ${file} was kept and nothing else was changed`, 500);
  let text = `The backup ${file} is ready and is downloading. Upload it in the other machine's manager (Upload a backup in the bot's Database window), then restore it there with the bot in Maintenance or Off. This bot stays stopped here, with its database login blocked, until you Cancel the move.`;
  if (await containerManager.appContainerRunning(botId) === true) {
    const stop = await containerManager.stopBotInOp(botId, 'move-out');
    if (!stop.success && stop.error !== 'Bot is not running') text += ` The bot here did not stop (${stop.error}); stop it, then press Rejoin as a copy.`;
  }
  return { success: true, text, file };
}

export const receive = (botId: string) => runLane(botId, 'receive', () => receiveMain(botId));
export const stopReceive = (botId: string) => runLane(botId, 'receive', () => stopReceiving(botId));
export const push = (botId: string, moveCode: string, confirm = false) => runLane(botId, 'push', admit => pushMain(botId, moveCode, confirm, admit));
export const moveOutByFile = (botId: string, confirm = false) => runLane(botId, 'move-out', () => moveOut(botId, confirm));

// ─── Download and upload ───

const DUMP_NAME_RE = /^[A-Za-z0-9._-]+\.dump$/;

/** The path of a dump of this bot's folder, or why it cannot be served. */
export function downloadPath(botId: string, file: string): { ok: true; path: string } | { ok: false; status: number; error: string } {
  if (!DUMP_NAME_RE.test(file) || file.includes('..')) return { ok: false, status: 400, error: 'Invalid dump file name' };
  const p = path.join(backupDir(botId), file);
  try {
    if (!fs.statSync(p).isFile()) return { ok: false, status: 404, error: 'Dump file not found' };
  } catch {
    return { ok: false, status: 404, error: 'Dump file not found' };
  }
  return { ok: true, path: p };
}

const gib = (n: number) => `${(n / (1024 * 1024 * 1024)).toFixed(1)} GiB`;

/** The free bytes of the backups folder's file system; null when it cannot be read. */
export const freeSpace = { of(dir: string): number | null {
  try {
    const s = fs.statfsSync(dir);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return null;
  }
} };

/**
 * O8: the request body streamed to moved-<stamp>.dump.tmp, synced, checked for the custom-format header, renamed and
 * the folder synced. The name is the manager's own, never the browser's.
 */
export function receiveUpload(botId: string, req: Request): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise(resolve => {
    const inst = containerManager.getBot(botId);
    if (!inst) return resolve({ status: 404, body: { success: false, error: 'Bot not found' } });
    if (containerManager.isShuttingDown()) return resolve({ status: 503, body: { success: false, error: containerManager.SHUTDOWN_REFUSAL } });
    if (!inst.fleetDb) return resolve({ status: 409, body: { success: false, error: 'This instance holds no main database to restore into; install it with a blank Database URL first' } });
    const length = Number(req.headers['content-length']);
    if (!req.headers['content-length'] || !Number.isSafeInteger(length) || length < 0) return resolve({ status: 411, body: { success: false, error: 'The upload carries no length' } });
    const dir = backupDir(botId);
    try { fs.mkdirSync(dir, { recursive: true }); } catch { /* the write below reports it */ }
    const free = freeSpace.of(dir);
    const need = length + MIN_FREE_BYTES;
    if (free !== null && free < need) return resolve({ status: 507, body: { success: false, error: `Not enough free disk space for this file (${gib(free)} free, ${gib(need)} needed), so nothing was written` } });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = `moved-${stamp}.dump`;
    const final = path.join(dir, file);
    const tmp = `${final}.tmp`;
    let done = false;
    const out = fs.createWriteStream(tmp, { mode: 0o600 });
    const fail = (status: number, error: string) => {
      if (done) return;
      done = true;
      out.destroy();
      try { fs.rmSync(tmp, { force: true }); } catch { /* the sweep at the next start deletes it */ }
      resolve({ status, body: { success: false, error } });
    };
    req.setTimeout?.(60_000, () => { req.destroy(); fail(408, 'The upload stopped sending data for 60 seconds, so nothing was kept'); });
    req.on('aborted', () => fail(400, 'The upload was cut off, so nothing was kept'));
    req.on('error', err => fail(500, `The file could not be written (${errText(err)}), so nothing was kept`));
    out.on('error', err => fail(500, `The file could not be written (${errText(err)}), so nothing was kept`));
    out.on('finish', () => {
      if (done) return;
      try {
        const fd = fs.openSync(tmp, 'r+');
        const head = Buffer.alloc(5);
        const n = fs.readSync(fd, head, 0, 5, 0);
        fs.fsyncSync(fd);
        fs.closeSync(fd);
        if (n < 5 || head.toString('latin1') !== 'PGDMP') return fail(400, 'This file is not a database backup made by the manager (pg_dump custom format), so it was not kept');
        fs.renameSync(tmp, final);
        try {
          const dfd = fs.openSync(dir, 'r');
          fs.fsyncSync(dfd);
          fs.closeSync(dfd);
        } catch { /* a folder sync is not supported everywhere */ }
      } catch (err) {
        return fail(500, `The file could not be written (${errText(err)}), so nothing was kept`);
      }
      done = true;
      console.log(`[Switch] ${inst.displayName}: uploaded a backup as ${file} (${utcText(Date.now())})`);
      resolve({ status: 200, body: { success: true, file, message: `Uploaded as ${file}. Put the bot in Maintenance or Off, then restore this file: the restore makes this machine the main.` } });
    });
    req.pipe(out);
  });
}
