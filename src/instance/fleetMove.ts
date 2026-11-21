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
import * as dbLogin from './dbLogin';
import * as fleetBackup from './fleetBackup';
import * as fleetJoin from './fleetJoin';
import * as fleetReplica from './fleetReplica';
import * as maintenance from './maintenance';
import { addressTableSql, getJoinCode } from './fleetReplication';
import { claimFleetBackupBusy, releaseFleetBackupBusy } from './fleetBackupGuards';
import { getBotDir } from '../git/repoManager';
import {
  backupDir, CHECKSUM_SQL, compareChecksums, compareCounts, COUNTS_SQL, parseChecksumLines, parseCountLines, utcText, validateDumpMeta,
} from './backupFiles';
import { decodeJoinCode, decodeMoveCode, encodeJoinCode, encodeMoveCode, JoinLogin, MoveCode, sqlLiteral } from '../config/joinCode';
import {
  copiesInsertSql, copyGroupEnsureSql, DB_OID_SQL, GEN_READ_SQL, machineNameOf, markIdOf, missingTable, OWN_COPIES_READ_SQL, parseGenRow, pushBrokenOf, raiseSql, RECEIVE_DROP_SQL,
  RECEIVE_END_SQL, RECEIVE_NOLOGIN_SQL, RECEIVED_OF_SQL, receiveMarkClearSql, receiveMarkSql, SHARD_CAP_DO_SQL,
} from './switchSql';
import {
  clusterSql, DbStop, ensureMainGeneration, finishUnconnectedHandover, finishWaitingHandover, handedOverNoAddress, handoverNoAddress, LaneOutcome, mainAdmission, metaSql, noticeRefusal, ownGeneration,
  provenMaintenance, runGuarded, runLane, sentence, setReceiveStep, stopAndReadDb, SWITCH_TIMING, switchAdmissionNotice, withoutNothing, workSql,
} from './fleetSwitch';
import { FleetDbReceive, InstanceConfig, JoinAddress } from '../types';

export const MOVE_TIMING = { receiveForMs: 24 * 60 * 60_000, clientMs: 60_000, pushMs: 30 * 60_000, verifyMs: 10 * 60_000, sessionPauseMs: 1_000, endRounds: 3 };
export const RECEIVE_ROLE = 'smdb_receive';
export const RECEIVE_META_ROLE = 'smdb_receive_meta';
const MIN_FREE_BYTES = 512 * 1024 * 1024;
const NOTHING = '; nothing was changed';
const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));
const lastLine = (text: string) => text.trim().split('\n').map(l => l.trim()).filter(l => l && !/(^|: )(WARNING|NOTICE): /.test(l)).pop() || 'no reason given';
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

const quoteIdent = (name: string) => `"${name.replace(/"/g, '""')}"`;
const PLAIN_ROLE = 'NOCREATEROLE NOREPLICATION NOBYPASSRLS';

/**
 * R3.6: both receive logins in one script, plain, until the receive's expiry: smdb_receive with the rights of
 * dbm_work, smdb_receive_meta with those of dbm_meta and the bot role, which drop, create and grant the database.
 */
export function receiveLoginsSql(user: string, password: string, metaPassword: string, expires: string): string {
  const login = (role: string, attrs: string, pw: string) => `IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}') THEN
  ALTER ROLE ${role} LOGIN NOSUPERUSER ${attrs} ${PLAIN_ROLE} PASSWORD ${sqlLiteral(pw)} VALID UNTIL ${sqlLiteral(expires)};
  ALTER ROLE ${role} RESET ALL;
ELSE
  CREATE ROLE ${role} LOGIN NOSUPERUSER ${attrs} ${PLAIN_ROLE} PASSWORD ${sqlLiteral(pw)} VALID UNTIL ${sqlLiteral(expires)};
END IF;
`;
  return `DO $$ BEGIN
${login(RECEIVE_ROLE, 'NOCREATEDB', password)}GRANT ${dbLogin.WORK_LOGIN} TO ${RECEIVE_ROLE};
${login(RECEIVE_META_ROLE, 'CREATEDB', metaPassword)}GRANT ${dbLogin.META_LOGIN}, ${quoteIdent(user)}, pg_signal_backend TO ${RECEIVE_META_ROLE};
ALTER ROLE ${RECEIVE_ROLE} SET search_path = pg_catalog, pg_temp;
ALTER ROLE ${RECEIVE_META_ROLE} SET search_path = pg_catalog, pg_temp;
END $$;`;
}

type Failed = { ok: false; error: string };
const failed = (r: { error?: string; stderr: string }): Failed => ({ ok: false, error: r.error || lastLine(r.stderr) });

const RECEIVE_LOGINS = `ARRAY['${RECEIVE_ROLE}', '${RECEIVE_META_ROLE}']`;

/**
 * Z1 and Q1 step 1, as the superuser on postgres: each receive login that exists opens only the socket (no password)
 * and loses its own settings; when the bot's database exists, its settings there go and A3's reset runs. Answers
 * `receive|<logins that exist>|<database exists>`.
 */
function receiveResetSql(db: string): string {
  const name = sqlLiteral(db);
  const reset = ['ALTER DATABASE %I IS_TEMPLATE false', 'ALTER DATABASE %I ALLOW_CONNECTIONS true', 'ALTER DATABASE %I CONNECTION LIMIT -1', 'ALTER DATABASE %I RESET ALL',
    `GRANT CONNECT, CREATE ON DATABASE %I TO ${dbLogin.META_LOGIN}`, `GRANT CONNECT ON DATABASE %I TO ${dbLogin.WORK_LOGIN}`]
    .map(statement => `  EXECUTE pg_catalog.format('${statement}', ${name});`).join('\n');
  return `DO $$
DECLARE l text;
BEGIN
FOREACH l IN ARRAY ${RECEIVE_LOGINS} LOOP
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = l) THEN
    EXECUTE pg_catalog.format('ALTER ROLE %I LOGIN PASSWORD NULL', l);
    EXECUTE pg_catalog.format('ALTER ROLE %I RESET ALL', l);
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_database WHERE datname = ${name}) THEN
      EXECUTE pg_catalog.format('ALTER ROLE %I IN DATABASE %I RESET ALL', l, ${name});
    END IF;
  END IF;
END LOOP;
IF EXISTS (SELECT 1 FROM pg_catalog.pg_database WHERE datname = ${name}) THEN
${reset}
END IF;
END $$;
SELECT 'receive|' || coalesce((SELECT pg_catalog.string_agg(rolname::text, ',' ORDER BY rolname) FROM pg_catalog.pg_roles WHERE rolname = ANY (${RECEIVE_LOGINS})), '')
  || '|' || (EXISTS (SELECT 1 FROM pg_catalog.pg_database WHERE datname = ${name}))::text;
`;
}

/** Q1's failure path: every receive login that exists takes no login and has no password. */
const RECEIVE_CLOSE_SQL = `DO $$
DECLARE l text;
BEGIN
FOREACH l IN ARRAY ${RECEIVE_LOGINS} LOOP
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = l) THEN
    EXECUTE pg_catalog.format('ALTER ROLE %I NOLOGIN PASSWORD NULL', l);
  END IF;
END LOOP;
END $$;
`;

/** Y3: what a receive login owns in the bot's database goes to the bot role, and what was granted to it goes. */
const clearOwnedSql = (login: string, user: string) => `REASSIGN OWNED BY ${login} TO ${quoteIdent(user)};\nDROP OWNED BY ${login};\n`;

type EndFailure = { ok: false; left?: number; once?: true; error: string };

/** One RECEIVE_END_SQL round: the sessions of both logins ended, then the count of those left. */
async function endRound(t: { container: string; user: string }): Promise<{ ok: true; left: number } | EndFailure> {
  const ended = await clusterSql(t, RECEIVE_END_SQL);
  if (!ended.ok) return failed(ended);
  const left = Number(ended.stdout.trim().split('\n').pop()?.trim() ?? '');
  return Number.isInteger(left) ? { ok: true, left } : { ok: false, error: 'the count of its sessions did not read' };
}

/**
 * Y3 with Z1 and Q1: both receive logins lose their password and settings, their sessions are ended and counted to
 * 0, each clears what it owns in the bot's database over the socket, then both take no login and are dropped. A
 * failure at any step leaves both logins closed and answers that failure; the next call starts again.
 */
async function endReceiveLogin(inst: InstanceConfig): Promise<{ ok: true } | EndFailure> {
  const db = inst.fleetDb!;
  const t = { container: db.containerName, user: db.user };
  const first = await endSteps(t, db.db);
  if (first.ok) return first;
  const close = await clusterSql(t, RECEIVE_CLOSE_SQL);
  if (!close.ok) return { ...first, error: `${first.error}; closing the logins also failed: ${failed(close).error}` };
  const round = await clusterSql(t, RECEIVE_END_SQL);
  if (!round.ok) return { ...first, error: `${first.error}; closing the logins also failed: ${failed(round).error}` };
  return first;
}

async function endSteps(t: { container: string; user: string }, botDb: string): Promise<{ ok: true } | EndFailure> {
  const reset = await clusterSql(t, receiveResetSql(botDb));
  if (!reset.ok) return failed(reset);
  const found = /^receive\|([a-z_,]*)\|(true|false)$/.exec(lastLine(reset.stdout));
  if (!found) return { ok: false, error: `the receive logins read back as ${lastLine(reset.stdout).slice(0, 200)}` };
  const logins = found[1] ? found[1].split(',') : [];
  let left = 0;
  for (let round = 1; round <= MOVE_TIMING.endRounds; round++) {
    if (round > 1) await new Promise(r => setTimeout(r, MOVE_TIMING.sessionPauseMs));
    const ended = await endRound(t);
    if (!ended.ok) return ended;
    left = ended.left;
    if (left === 0) break;
  }
  if (left > 0) return { ok: false, left, error: `${left} session(s) did not end` };
  if (found[2] === 'true') {
    for (const login of [RECEIVE_ROLE, RECEIVE_META_ROLE] as const) {
      if (!logins.includes(login)) continue;
      const call = dbLogin.receivePsql(login, t.container, botDb, clearOwnedSql(login, t.user), { stdin: true, exempt: true });
      const clean = await runGuarded('docker', [...call.args, '-q'], { input: call.input, timeoutMs: SWITCH_TIMING.readMs });
      if (!clean.ok && !noRow(clean.stderr)) return failed(clean);
    }
  }
  const nologin = await clusterSql(t, RECEIVE_NOLOGIN_SQL);
  if (!nologin.ok) return failed(nologin);
  const last = await endRound(t);
  if (!last.ok) return last;
  if (last.left > 0) return { ok: false, left: last.left, once: true, error: `${last.left} session(s) did not end` };
  const drop = await clusterSql(t, RECEIVE_DROP_SQL);
  return drop.ok ? { ok: true } : failed(drop);
}

/** A psql error that says the bot database or an smdb_manager table is missing: no push committed into it. */
const noRow = (stderr: string) => missingTable(stderr) || /database "[^"]*" does not exist/.test(stderr);

/** The newest received row of the mark's ids (D53) as `<machine>|<generation>`, '' for none. */
async function receivedLine(inst: InstanceConfig, r: FleetDbReceive): Promise<{ ok: true; line: string } | Failed> {
  const db = inst.fleetDb!;
  const got = await metaSql({ container: db.containerName, user: db.user }, db.db, RECEIVED_OF_SQL([r.pushId, ...(r.priorIds ?? [])]));
  if (!got.ok) return noRow(got.stderr) ? { ok: true, line: '' } : failed(got);
  return { ok: true, line: got.stdout.trim() };
}

/** D42: whether a push replaced this database (another oid, or none) and wrote no received row of the mark's ids. */
async function pushCheck(inst: InstanceConfig): Promise<{ ok: true; broken: boolean; done: string | null } | Failed> {
  const db = inst.fleetDb!;
  const r = db.receive!;
  const oid = await clusterSql({ container: db.containerName, user: db.user }, DB_OID_SQL(db.db));
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
/** The expiry's end failure last logged per bot (Y3: once per distinct error); cleared when the receive ends. */
const endErrorLogged = new Map<string, string>();

/** D51: a push of the mark finished: the copies written back, the login ended; receive, pushBroken and a hand-over with no address cleared in one save. */
async function finishReceive(inst: InstanceConfig, r: FleetDbReceive, line: string): Promise<{ ok: true; machine: string; generation: string } | { ok: false; error: string; saveFailed?: boolean }> {
  const db = inst.fleetDb!;
  dbLogin.noteLoginFault(db.containerName);
  if (r.copies?.length) {
    const back = await metaSql({ container: db.containerName, user: db.user }, db.db, copiesInsertSql(r.copies));
    if (!back.ok) console.warn(`[Switch] ${inst.displayName}: this machine's copies could not be listed again after the push (${back.error || lastLine(back.stderr)}); they register again within an hour`);
  }
  const ended = await endReceiveLogin(inst);
  if (!ended.ok) return { ok: false, error: ended.error };
  const handedOver = handedOverNoAddress(containerManager.getBot(inst.id)?.fleetDb?.handover);
  const saved = saveSwitch(inst.id, { receive: null, pushBroken: null, ...(handedOver ? { handover: null } : {}) });
  if (saved) return { ok: false, error: saved, saveFailed: true };
  await clearMarkLogged(inst, markIdOf(r));
  sessionsLogged.delete(inst.id);
  endErrorLogged.delete(inst.id);
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
  const r = await metaSql({ container: db.containerName, user: db.user }, db.db, OWN_COPIES_READ_SQL);
  return r.ok ? fleetJoin.parseAddressRows(r.stdout) : [];
}

/** D62: the receive mark row of this mark id removed from the cluster's postgres database; the error, or null. */
async function clearMark(inst: InstanceConfig, markId: string): Promise<string | null> {
  const db = inst.fleetDb!;
  const r = await clusterSql({ container: db.containerName, user: db.user }, receiveMarkClearSql(markId));
  return r.ok ? null : failed(r).error;
}

async function clearMarkLogged(inst: InstanceConfig, markId: string): Promise<void> {
  const error = await clearMark(inst, markId);
  if (error) console.warn(`[Switch] ${inst.displayName}: the mark that tells this database's copies it is receiving could not be removed (${error}); the manager tries again every minute`);
}

type Stopped = Exclude<DbStop, { runs: false }>;
/** After a refused Receive whose database did not stop again: what docker shows, and the login only when this press read it blocked. */
const stopAgainTail = (stop: Stopped, proven: boolean) => (stop.runs
  ? ` The database was started for Receive and did not stop again (${stop.error}); it runs${proven ? " with the bot's login blocked" : ", the manager can't confirm that the bot's login is blocked"}, and the hand-over stays recorded.`
  : ` The database was started for Receive, and the manager can't confirm that it stopped again (${stop.error}); the hand-over stays recorded.`);

type Back = { machine: string; stop: DbStop } | { machine: string; skipped: string };

/**
 * A receive that ended with no push under a hand-over with no address: the database stopped again. Null when no such
 * record stands. The tick holds no operation, so it takes one for the stop and gives way to a lane or a new receive.
 */
async function stoppedAgain(botId: string, tick = false): Promise<Back | null> {
  const db = containerManager.getBot(botId)?.fleetDb;
  if (!db || !handedOverNoAddress(db.handover)) return null;
  const machine = db.handover?.machine || 'another machine';
  if (!tick) return { machine, stop: await stopAndReadDb(botId, db.containerName) };
  const BUSY = 'an operation on this bot is running';
  if (db.receive) return { machine, skipped: 'a new receive stands' };
  if (containerManager.isBotBusy(botId)) return { machine, skipped: BUSY };
  try {
    return await containerManager.withExternalBotOp(botId, 'receive', async () => {
      const now = containerManager.getBot(botId)?.fleetDb;
      if (!now || !handedOverNoAddress(now.handover)) return null;
      if (now.receive) return { machine, skipped: 'a new receive stands' };
      return { machine, stop: await stopAndReadDb(botId, now.containerName) };
    });
  } catch (err) {
    return { machine, skipped: `the stop could not run (${errText(err)})` };
  }
}

export async function receiveMain(botId: string): Promise<LaneOutcome> {
  const inst = containerManager.getBot(botId);
  if (!inst) return refusal('Bot not found', 404);
  const db = inst.fleetDb;
  if (!db || db.retiringAt) return refusal(`This instance holds no main database to replace; install it with a blank Database URL first${NOTHING}`);
  if (!db.replication) return refusal(`Replication is not enabled, so the other machine has no address to push to; enable it first${NOTHING}`);
  const prior = db.receive;
  if (!prior) {
    const admission = mainAdmission(inst, { replication: true, noun: 'replace', allowPushBroken: true, resume: handoverNoAddress });
    if (admission) return refusal(admission);
  }
  if (noticeRefusal(botId, 'receiving was refused')) {
    return refusal(`Receiving was refused and nothing was changed: a restore of ${fleetBackup.shownRestoreNoticeFile(botId)} has not finished cleanly here (its notice is on the Database window), and a push would replace the database that notice is about. Dismiss the notice, or restore a dump again, then press Receive.`);
  }
  const finish = await finishWaitingHandover(botId);
  const to = db.handover?.machine || 'another machine';
  if (finish.state === 'failed') return refusal(`Receiving was refused and nothing was changed: docker shows this database and the bot stopped, but the manager could not save the hand-over to ${to} as finished (${finish.error}); try again.`);
  // A press that finished the record says so in its reply, and its later refusals no longer say that nothing was changed.
  let note = '';
  if (finish.state === 'open') {
    const done = await finishUnconnectedHandover(botId, finish);
    if (!done.ok) return refusal(done.text, done.status);
    note = done.note;
  }
  if (finish.state === 'finished') note = ` The hand-over to ${to} is now recorded as finished: docker showed this database and the bot stopped.`;
  if (!note) return receiveFrom(botId, inst);
  const out = await receiveFrom(botId, containerManager.getBot(botId)!);
  return { ...out, text: out.success ? `${out.text}${note}` : `${sentence(withoutNothing(out.text))}${note}` };
}

/** Receive past the checks that read no state of the bot: the state test, and under a hand-over with no address the start and the stop-again. */
async function receiveFrom(botId: string, inst: InstanceConfig): Promise<LaneOutcome> {
  const db = inst.fleetDb!;
  const rec = maintenance.maintenanceOf(inst);
  const handedOver = handedOverNoAddress(db.handover) ? db.handover : null;
  if (!handedOver) {
    if (rec.state !== 'off' || !rec.settled) {
      return refusal(`Receiving replaces this machine's database, so the bot must be Off first (its state is ${NAME[rec.state]}${rec.settled ? '' : ', not confirmed'}); choose Off in the State window${NOTHING}`);
    }
    return receiveAdmitted(botId, inst, {});
  }
  const from = handedOver.machine || 'another machine';
  if (rec.state === 'running' || !rec.settled) {
    return refusal(`Receiving was refused and nothing was changed: taking the main back needs the bot in a confirmed Maintenance or Off, and its state is ${NAME[rec.state]}${rec.settled ? '' : ', not confirmed'}`);
  }
  const app = await containerManager.appContainerRunning(botId);
  if (app === true) return refusal("Receiving was refused and nothing was changed: the bot runs here, and taking the main back needs docker to show it stopped. Press Stop on the bot's card, then Receive a main again.");
  if (app !== false) return refusal("Receiving was refused and nothing was changed: the manager can't confirm that the bot is stopped here (docker did not say whether it runs). Press Receive a main again.");
  const container = db.containerName;
  // tried: this press called the start, so a database left up by it is stopped again when no receive stands at the end.
  let tried = false;
  let startError: string | null = null;
  let threw = false;
  const flow: { proven?: boolean } = {};
  let out: LaneOutcome;
  try {
    if (await dbLogin.sidecarRunning(container) !== true) {
      tried = true;
      const up = await containerManager.startFleetDbSidecar(botId, { handedOver: true });
      if (!up.success) startError = up.error || 'no reason given';
    }
    out = startError !== null ? refusal(`Receiving was refused: this machine's database did not start (${startError})`) : await receiveAdmitted(botId, inst, flow);
  } catch (err) {
    threw = true;
    out = { success: false, status: 500, text: `Receiving stopped on an unexpected error (${errText(err)}).` };
  }
  const now = containerManager.getBot(botId)?.fleetDb;
  if (now?.receive || !handedOverNoAddress(now?.handover)) {
    if (startError !== null) return refusal(`${out.text}; receiving stays recorded. Press Receive a main again.`);
    if (!out.success || !out.moveCode) return out;
    return { ...out, text: `${out.text} This machine's database ${tried ? 'was started' : 'runs'} to receive it; the hand-over to ${from} stays recorded until the push finishes.` };
  }
  if (!tried) return out;
  const stop = await stopAndReadDb(botId, container);
  if (stop.runs === false) {
    if (startError !== null) return refusal(`${out.text}${NOTHING}`);
    return threw ? { ...out, text: `${out.text} This machine's database is stopped again, and the hand-over stays recorded.` } : out;
  }
  if (startError !== null) {
    return refusal(stop.runs
      ? `${out.text}. Its container did not stop again (${stop.error}); it runs, the manager can't confirm that the bot's login is blocked, and the hand-over stays recorded.`
      : `${out.text}. The manager can't confirm that its container stopped again (${stop.error}); the hand-over stays recorded.`);
  }
  return { ...out, text: `${sentence(withoutNothing(out.text))}${stopAgainTail(stop, !!flow.proven)}` };
}

/** Receive past its admission: the login proof, the dump, the record, the mark, the logins and the move code. */
async function receiveAdmitted(botId: string, inst: InstanceConfig, flow: { proven?: boolean }): Promise<LaneOutcome> {
  const db = inst.fleetDb!;
  const prior = db.receive;
  const proof = await maintenance.requireMaintenance(botId, 'database');
  if (!proof.ok) return refusal(`Receiving was refused and nothing was changed: ${proof.error}`);
  flow.proven = true;
  const fence = await switchAdmissionNotice(botId, 'receiving was refused', { skipNotice: true });
  if (fence) return refusal(fence);
  const t = { container: db.containerName, user: db.user };
  const ensured = await clusterSql(t, copyGroupEnsureSql());
  if (!ensured.ok) return refusal(`The manager could not make sure the group of the machines' logins (smdb_copies) exists in this database's cluster (${failed(ensured).error}), and a pushed database that grants to it would not restore${NOTHING}`, 500);

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
    const oid = await clusterSql(t, DB_OID_SQL(db.db));
    if (!oid.ok || (!broken && !oid.stdout.trim())) {
      const error = oid.ok ? 'the database is missing' : failed(oid).error;
      return refusal(`The manager could not read this database's identity before receiving (${error}), so it could not tell later whether a push replaced it; the dump ${safetyDump} was kept and nothing else was changed`, 500);
    }
    dbOid = oid.stdout.trim();
    copies = broken?.copies ?? await ownCopies(inst);
  }
  const join = await getJoinCode(containerManager.getBot(botId) ?? inst, { forReceive: true });
  const decoded = join.success && join.joinCode ? decodeJoinCode(join.joinCode) : null;
  if (!decoded || !decoded.ok) {
    const error = join.success ? 'the join code did not decode' : join.error || 'the join code did not decode';
    if (prior) return refusal(`The move code could not be made (${error}), so no new move code was made; the code shown before still works until ${utcText(Date.parse(prior.expiresAt))}.`, 500);
    return refusal(`The move code could not be made (${error}); the dump ${safetyDump} was kept; receiving was not started`, 500);
  }
  const startedAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + MOVE_TIMING.receiveForMs).toISOString();
  const pushId = crypto.randomBytes(12).toString('hex');
  const priorIds = prior ? [...(prior.priorIds ?? []), prior.pushId] : [];
  const marked = saveSwitch(botId, { receive: { startedAt: prior?.startedAt ?? startedAt, expiresAt, safetyDump, pushId, priorIds, dbOid, copies } });
  if (marked) return refusal(`Receiving could not be recorded (${marked}); the dump ${safetyDump} was kept; receiving was not started`, 500);
  const backTail = (back: string | null) => (back ? ` The manager could not put the earlier record back (${back}); a push made with the earlier code is still recognised.` : '');
  const unrecTail = (back: string) => `. The manager could not clear its record of receiving (${back}); press Stop receiving.`;
  const written = await clusterSql(t, receiveMarkSql(priorIds[0] ?? pushId, [...priorIds, pushId], broken ? '' : dbOid));
  if (!written.ok) {
    const error = failed(written).error;
    const back = saveSwitch(botId, { receive: prior ?? null });
    if (prior) return refusal(`The manager could not write the new move code's id into the mark that tells this database's copies a push may replace it (${error}), so no new move code was made; the code shown before still works until ${utcText(Date.parse(prior.expiresAt))}.${backTail(back)}`, 500);
    const lead = `Receiving was not started: the manager could not write the mark that tells this database's copies a push may replace it (${error}). The dump ${safetyDump} was kept`;
    return refusal(back ? `${lead}${unrecTail(back)}` : `${lead}; nothing else was changed.`, 500);
  }
  const password = crypto.randomBytes(24).toString('base64url');
  const metaPassword = crypto.randomBytes(24).toString('base64url');
  const role = await clusterSql(t, receiveLoginsSql(db.user, password, metaPassword, expiresAt));
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
  const moveCode = encodeMoveCode({ ...decoded.code, recv: { user: RECEIVE_ROLE, password, id: pushId }, recvMeta: { user: RECEIVE_META_ROLE, password: metaPassword } });
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
    if (ended.left !== undefined) return refusal(`The receive login no longer accepts new sessions, but ${ended.left} of its session(s) did not end${ended.once ? '' : ' after three tries'}, so receiving was not stopped; press Stop receiving again.`, 500);
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
  endErrorLogged.delete(botId);
  const still = containerManager.getBot(botId)?.fleetDb?.pushBroken;
  if (!check.broken && !still) await clearMarkLogged(inst, markIdOf(r));
  const back = await stoppedAgain(botId);
  if (!back) {
    if (check.broken) return { success: true, text: `Receiving stopped; the move code no longer works. A push replaced this machine's database and did not finish, so the database is empty or holds data that was not checked, and the bot cannot run on it: restore the dump ${r.safetyDump} (taken before receiving) with the bot in Maintenance or Off, or press Receive again so the other machine can push again.` };
    const tail = still ? ` A push that did not finish earlier still stands: restore the dump ${still.safetyDump} (taken before that push) with the bot in Maintenance or Off, or press Receive again.` : '';
    return { success: true, text: `Receiving stopped; the move code no longer works.${tail}` };
  }
  const stop = 'stop' in back ? back.stop : null;
  const backTail = !stop || stop.runs === false ? ` This machine's database is stopped again; the hand-over to ${back.machine} is still recorded.`
    : stop.runs ? ` This machine's database did not stop (${stop.error}); it still runs, and the hand-over to ${back.machine} is still recorded.`
    : ` The manager can't confirm that this machine's database stopped (${stop.error}); the hand-over to ${back.machine} is still recorded.`;
  const kept = (dump: string, taken: string) => `press Receive a main again so ${back.machine} can push again. The dump ${dump} (taken before ${taken}) stays with the backups; a restore is refused while the hand-over to ${back.machine} is recorded.`;
  if (check.broken) return { success: true, text: `Receiving stopped; the move code no longer works. A push replaced this machine's database and did not finish, so the database is empty or holds data that was not checked, and the bot cannot run on it: ${kept(r.safetyDump, 'receiving')}${backTail}` };
  const tail = still ? ` A push that did not finish earlier still stands: ${kept(still.safetyDump, 'that push')}` : '';
  return { success: true, text: `Receiving stopped; the move code no longer works.${tail}${backTail}` };
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
    if (ended.left !== undefined) {
      if (sessionsLogged.get(inst.id) !== ended.left) {
        sessionsLogged.set(inst.id, ended.left);
        console.log(`[Switch] ${inst.displayName}: the move code expired, but ${ended.left} session(s) of the receive login did not end; the manager tries again every minute`);
      }
    } else if (endErrorLogged.get(inst.id) !== ended.error) {
      endErrorLogged.set(inst.id, ended.error);
      console.warn(`[Switch] ${inst.displayName}: the move code expired, but the receive login could not be removed (${ended.error}); the manager tries again every minute`);
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
  endErrorLogged.delete(inst.id);
  const back = await stoppedAgain(inst.id, true);
  containerManager.broadcastBotUpdated(inst.id);
  const dbNow = !back ? '' : 'skipped' in back ? `; the database was not stopped: ${back.skipped}`
    : back.stop.runs === false ? '; the database is stopped again'
    : back.stop.runs ? `; the database did not stop (${back.stop.error})` : `; the manager can't confirm that the database stopped (${back.stop.error})`;
  const until = back ? `a push from ${back.machine} finishes (the dump ${r.safetyDump} stays with the backups; a restore is refused while the hand-over is recorded)` : `the dump ${r.safetyDump} is restored or a push finishes`;
  console.log(check.broken
    ? `[Switch] ${inst.displayName}: the move code expired; a push replaced this database and did not finish, so the bot stays stopped until ${until}; the receive login is removed${dbNow}`
    : `[Switch] ${inst.displayName}: the move code expired unused; the receive login is removed${dbNow}`);
}

setReceiveStep(receiveStep);

// ─── O6 Push ───

/** Which of the move code's two logins a receiver call uses (R3.6). */
type ReceiverLogin = 'recv' | 'meta';
const loginOfCode = (code: MoveCode, as: ReceiverLogin): JoinLogin => (as === 'recv' ? code.recv : code.recvMeta);

function recvDsn(code: MoveCode, db: string, as: ReceiverLogin): string {
  return `postgresql://${encodeURIComponent(loginOfCode(code, as).user)}@${code.host}:${code.port}/${db}?sslmode=verify-full&sslrootcert=/primary-ca.crt`;
}

interface ClientCall { as: ReceiverLogin; suffix: string; script: string; args: string[]; timeoutMs: number; input?: string; inputPath?: string; mounts?: string[] }

/**
 * A client tool against the receiver as one of the move code's logins, in a throwaway client container, with the
 * manager's session pins (U2). Stdin is `input`, or a file streamed in from `inputPath`; both passwords are scrubbed.
 */
async function receiverClient(inst: InstanceConfig, code: MoveCode, pem: string, call: ClientCall) {
  const mounts = [`${fleetJoin.ensureProbeCert(inst.id, code.fp, pem)}:/primary-ca.crt:ro`, ...(call.mounts ?? [])];
  const name = `${inst.sanitizedName}-fleet-move-${call.suffix}`;
  const stdin = call.input !== undefined || call.inputPath !== undefined;
  await runGuarded('docker', ['rm', '-f', name], { timeoutMs: 30_000 });
  const r = await runGuarded('docker', ['run', '--rm', ...(stdin ? ['-i'] : []), '--name', name, '-e', 'PGPASSWORD', '-e', `PGOPTIONS=${dbLogin.MANAGER_SESSION_OPTIONS}`,
    ...mounts.flatMap(m => ['-v', m]), '--entrypoint', 'sh', 'postgres:16-alpine', '-c', call.script, 'sh', ...call.args],
    { timeoutMs: call.timeoutMs, env: { ...process.env, PGPASSWORD: loginOfCode(code, call.as).password }, ...(call.input !== undefined ? { input: call.input } : {}), ...(call.inputPath ? { inputPath: call.inputPath } : {}) });
  if (!r.ok && r.code === null) await runGuarded('docker', ['rm', '-f', name], { timeoutMs: 30_000 });
  const scrub = (s: string) => [code.recv.password, code.recvMeta.password].reduce((text, p) => text.split(p).join('***'), s);
  return { ...r, stderr: scrub(r.stderr), error: r.error ? scrub(r.error) : r.error };
}

/** U7: a receive login refused after the pg_restore succeeded. */
const RECEIVE_REFUSED_RE = new RegExp(`password authentication failed for user "(${RECEIVE_ROLE}|${RECEIVE_META_ROLE})"`);

/** X1 and S2 on the sender: its own dump's smdb_manager rows as the parse wrote them, and the `-L` list of the rest. */
async function readOwnDump(inst: InstanceConfig, dumpPath: string): Promise<{ ok: true; script: string; list: string } | { ok: false; text: string }> {
  const container = inst.fleetDb!.containerName;
  const unread = (error: string) => ({ ok: false as const, text: `The push was refused: this database's dump could not be read (${error}). Nothing was sent; the other machine is unchanged.` });
  const meta = await fleetBackup.readArchiveMeta(container, dumpPath);
  if (!meta.ok) {
    if ('error' in meta) return unread(meta.error);
    return { ok: false, text: `The push was refused: this database's dump holds smdb_manager rows the manager could not read (${meta.problem}). Nothing was sent; the other machine is unchanged.` };
  }
  const { check, cap } = meta.skipped;
  if (check + cap > 0) console.warn(`[Switch] ${inst.displayName}: left out ${check + cap} row(s) of smdb_manager.addresses from the pushed dump (${check} failed the address check or were over the size limit, ${cap} past the 1000-row cap)`);
  const toc = await fleetBackup.readDumpToc(container, dumpPath);
  if (!toc.ok) return unread(toc.error);
  if (toc.toc.length >= fleetBackup.TOC_MAX_CHARS) return unread('its table of contents is longer than 8 MB, so the restore list made from it could miss an entry');
  const managerToc = await fleetBackup.readDumpToc(container, dumpPath, 'smdb_manager');
  if (!managerToc.ok) return unread(managerToc.error);
  const lists = fleetBackup.restoreLists(toc.toc, managerToc.toc);
  if (lists.refused !== null) return unread(lists.refused);
  return { ok: true, script: meta.script, list: lists.other };
}

/** Y1: the push compares every table but smdb_manager.addresses, whose rows the commit writes anew, and the save order's tables, which it never writes. */
function withoutAddresses<T>(rows: Record<string, T>): Record<string, T> {
  const { 'smdb_manager.addresses': _left, ...rest } = fleetBackup.withoutSaveOrder(rows);
  return rest;
}

const PUSH_LIST = 'push-restore.list';

const LOGIN_RE = /password authentication failed|pg_hba\.conf rejects connection|no pg_hba\.conf entry|is not permitted to log in|role "[^"]*" does not exist|VALID UNTIL|expired/i;

export async function pushMain(botId: string, moveCode: string, confirm: boolean, admit: () => void = () => undefined): Promise<LaneOutcome> {
  const inst = containerManager.getBot(botId);
  if (!inst) return refusal('Bot not found', 404);
  const decoded = decodeMoveCode(moveCode);
  if (!decoded.ok) return refusal(decoded.old ? decoded.why : `This is not a move code: ${decoded.why}`, 400);
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
      const re = await fleetReplica.reseedStalePrimary(fresh, joinText, fresh.fleetDb?.replication?.publicHost, fresh.fleetDb?.replication?.hostPort, false, { dumpDone: !!safetyDump, ...(safetyDump ? { safetyDump } : {}) });
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
  const sys = await clusterSql(t, 'SELECT system_identifier FROM pg_control_system();');
  if (!sys.ok) return out(refusal(`The manager could not read this database's identity (${sys.error || lastLine(sys.stderr)})${NOTHING}`));
  const systemId = lastLine(sys.stdout);
  const probeScript = 'psql -X "$1" -v ON_ERROR_STOP=1 -Atc "SELECT pg_is_in_recovery()::text" || exit 2; '
    + 'psql -X "$2" -v ON_ERROR_STOP=1 -Atc "$3" 2>/tmp/g.err || { if grep -q "does not exist" /tmp/g.err; then echo "0||"; else cat /tmp/g.err >&2; exit 3; fi; }; '
    + 'psql -X "$2" -v ON_ERROR_STOP=1 -Atc "$4" 2>/tmp/r.err || { if grep -q "does not exist" /tmp/r.err; then echo "0"; else cat /tmp/r.err >&2; exit 4; fi; }';
  const probe = await receiverClient(inst, code, cert.pem, { as: 'meta', suffix: 'probe', script: probeScript, timeoutMs: MOVE_TIMING.clientMs,
    args: [recvDsn(code, 'postgres', 'meta'), recvDsn(code, code.db, 'meta'), GEN_READ_SQL, `SELECT count(*) FROM smdb_manager.received WHERE push_id = ${sqlLiteral(code.recv.id)}`] });
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
  const ensured = already ? null : await ensureMainGeneration(botId);
  const own = await ownGeneration(t, db.db);
  if (!own.ok) return out(refusal(`The manager could not read this database's generation (${own.error})${NOTHING}`));
  if (ensured && !own.row) {
    const why = ensured.kind === 'failed' ? `writing it failed (${ensured.error})` : ensured.kind === 'skipped' ? `the manager did not write it (${ensured.why})` : 'the write ran but left no row (a database in recovery takes none)';
    return out(refusal(`The push was refused: this database has no generation row, and ${why}${NOTHING}`));
  }
  const ownGen = own.row?.generation ?? 0;
  const ownMachine = own.row?.machine || machineNameOf(inst);
  if (!already && theirGen && (theirGen.generation > ownGen || (theirGen.generation === ownGen && theirGen.generation > 1 && theirGen.machine !== ownMachine))) {
    return out(refusal(`The push was refused: ${where} holds a newer main than this database (generation ${theirGen.generation} from ${theirGen.machine || where}; this database is at generation ${ownGen} from ${ownMachine}), so a push would replace its data with older data${NOTHING}`));
  }
  const target = Math.max(own.row?.generation ?? 0, theirGen?.generation ?? 0) + 1;

  let file = db.handover?.mode === 'push' ? db.handover.file ?? '' : '';
  let committedNow = false;
  if (!already) {
    const reset = await clusterSql(t, dbLogin.databaseResetSql(db.db));
    if (!reset.ok) return out(refusal(`The push was refused: this database's own settings could not be reset before the dump (${failed(reset).error}). Nothing was sent; the other machine is unchanged.`));
    const dump = await fleetBackup.runFleetDump(inst, 'pre-push-');
    if (!dump.success || !dump.file) return out(refusal(`The dump of this database failed (${dump.error || 'no reason given'}), so nothing was pushed`));
    file = dump.file;
    const dumpPath = path.join(backupDir(botId), file);
    const own = await readOwnDump(inst, dumpPath);
    if (!own.ok) return out(refusal(own.text), file);
    const listPath = path.join(getBotDir(botId), 'fleet-join', PUSH_LIST);
    try {
      fs.mkdirSync(path.dirname(listPath), { recursive: true });
      fs.writeFileSync(listPath, own.list);
    } catch (err) {
      return out(refusal(`The push was refused: the list of the dump's entries could not be written (${errText(err)}). Nothing was sent; the other machine is unchanged.`), file);
    }
    let failure: ReturnType<typeof out> | null;
    try {
      failure = await sendPush(inst, code, cert.pem, { file, dumpPath, target, systemId, metaScript: own.script, admit, listMount: `${containerManager.hostBotDirFor(botId)}/fleet-join/${PUSH_LIST}:${fleetBackup.RESTORE_LIST_PATH}:ro` });
    } finally {
      try { fs.rmSync(listPath, { force: true }); } catch { /* the next push writes it again */ }
    }
    if (failure) return failure;
    committedNow = true;
  } else {
    admit();
  }
  const prior = containerManager.getBot(botId)?.fleetDb?.handover;
  const { lastError: _cleared, ...kept } = prior?.mode === 'push' ? prior : { mode: 'push' as const, machine, host: code.host, port: code.port, generation: target, file, at: new Date().toISOString(), phase: 'pushing' as const, lastError: undefined };
  const doneError = saveSwitch(botId, { handover: { ...kept, phase: 'done' } });
  if (committedNow) await lastStep(inst, code, cert.pem);
  const meta = file ? readMeta(path.join(backupDir(botId), file)) : null;
  const compared = meta ? withoutAddresses(meta.counts) : null;
  const checked = compared ? `${Object.keys(compared).length} tables and ${Object.values(compared).reduce((a, b) => a + b, 0)} rows` : 'every table';
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

interface PushPlan { file: string; dumpPath: string; target: number; systemId: string; metaScript: string; listMount: string; admit: () => void }

/**
 * R3.6 on the receiver, after the push is recorded: the drop, create and grants as smdb_receive_meta; its meta
 * transaction under SET ROLE dbm_meta on stdin (X1, Z5); smdb_receive's pg_restore of the other entries (S2); the
 * counts and checksums without smdb_manager.addresses (Y1); the cap as smdb_receive, then the raise as
 * smdb_receive_meta. Answers the failure, or null once the raise committed.
 */
async function sendPush(inst: InstanceConfig, code: MoveCode, pem: string, p: PushPlan): Promise<{ outcome: LaneOutcome; safetyDump: string } | null> {
  const botId = inst.id;
  const user = inst.fleetDb!.user;
  const machine = code.machine;
  const marked = saveSwitch(botId, { handover: { mode: 'push', machine, host: code.host, port: code.port, generation: p.target, file: p.file, phase: 'pushing', at: new Date().toISOString() } });
  if (marked) return { outcome: refusal(`The push could not be recorded (${marked}); the dump ${p.file} was kept and nothing was pushed`, 500), safetyDump: p.file };
  p.admit();
  const fail = (text: string) => {
    saveSwitch(botId, { handover: { ...containerManager.getBot(botId)!.fleetDb!.handover!, lastError: text } });
    return { outcome: refusal(text, 500), safetyDump: p.file };
  };
  const why = (r: { error?: string; stderr: string }) => r.error || lastLine(r.stderr);
  const pushFailed = (r: { error?: string; stderr: string }) => fail(`The push to ${machine} failed (${why(r)}). This machine's database is unchanged; ${machine}'s database is incomplete, and its bot stays Off. Press Push again with the same code, or Cancel the push.`);
  const loginGone = (r: { ok: boolean; stderr: string }) => !r.ok && RECEIVE_REFUSED_RE.test(r.stderr);
  const RECVLOGIN = `The push to ${machine} stopped: ${machine} refused the move code's login after the data was sent (code in the pushed database may have changed its password, or the code expired, or receiving was stopped or restarted there). ${machine}'s database is incomplete, and its bot stays Off. On ${machine}, press Receive for a new move code and push with it, or Cancel the push.`;
  const mismatch = (what: string) => fail(`The pushed copy on ${machine} does not match this database (${what}), so ${machine} was not made the main. Press Push again, or Cancel the push.`);

  const dbIdent = quoteIdent(code.db);
  const arg = (sql: string) => `'${sql.replace(/'/g, "'\\''")}'`;
  const createScript = `psql -X "$1" -v ON_ERROR_STOP=1 -c ${arg(`DROP DATABASE IF EXISTS ${dbIdent} WITH (FORCE)`)} -c ${arg(`CREATE DATABASE ${dbIdent} OWNER ${quoteIdent(user)}`)}`
    + ` -c ${arg(`GRANT CONNECT, CREATE ON DATABASE ${dbIdent} TO ${dbLogin.META_LOGIN}`)} -c ${arg(`GRANT CONNECT ON DATABASE ${dbIdent} TO ${dbLogin.WORK_LOGIN}`)}`;
  const created = await receiverClient(inst, code, pem, { as: 'meta', suffix: 'create', script: createScript, args: [recvDsn(code, 'postgres', 'meta')], timeoutMs: MOVE_TIMING.clientMs });
  if (!created.ok) return pushFailed(created);
  const metaTx = `SET ROLE ${dbLogin.META_LOGIN};\nBEGIN;\n${fleetBackup.metaTransactionSql(p.metaScript)}COMMIT;\n`;
  const written = await receiverClient(inst, code, pem, { as: 'meta', suffix: 'meta', script: 'psql -X "$1" -v ON_ERROR_STOP=1 -q', args: [recvDsn(code, code.db, 'meta')], timeoutMs: MOVE_TIMING.pushMs, input: metaTx });
  if (!written.ok) return pushFailed(written);
  const restoreScript = `pg_restore -d "$1" --role="$2" --no-owner --no-privileges --single-transaction --exit-on-error -L ${fleetBackup.RESTORE_LIST_PATH}`;
  const pushed = await receiverClient(inst, code, pem, { as: 'recv', suffix: 'push', script: restoreScript, args: [recvDsn(code, code.db, 'recv'), user], timeoutMs: MOVE_TIMING.pushMs, inputPath: p.dumpPath, mounts: [p.listMount] });
  if (!pushed.ok) return pushFailed(pushed);

  let meta;
  try {
    const parsed = validateDumpMeta(JSON.parse(fs.readFileSync(`${p.dumpPath}.json`, 'utf-8')));
    if (!parsed.ok) throw new Error(parsed.error);
    meta = parsed.meta;
  } catch (err) {
    return mismatch(`the counts could not be read (${errText(err)})`);
  }
  const read = (suffix: string, sql: string) => receiverClient(inst, code, pem, { as: 'recv', suffix, script: 'psql -X "$1" -v ON_ERROR_STOP=1 -Atc "$2"', args: [recvDsn(code, code.db, 'recv'), sql], timeoutMs: MOVE_TIMING.verifyMs });
  const counts = await read('counts', COUNTS_SQL);
  if (loginGone(counts)) return fail(RECVLOGIN);
  const theirCounts = counts.ok ? parseCountLines(counts.stdout) : null;
  if (!theirCounts || !theirCounts.ok) return mismatch(`the counts could not be read (${!counts.ok ? why(counts) : theirCounts && !theirCounts.ok ? theirCounts.error : 'no answer'})`);
  const cmp = compareCounts(withoutAddresses(meta.counts), withoutAddresses(theirCounts.counts));
  if (!cmp.ok) return mismatch(`counts: ${cmp.text}`);
  const sums = await checksumsOf({ container: inst.fleetDb!.containerName, user }, inst.fleetDb!.db);
  const theirSums = await read('sums', CHECKSUM_SQL);
  if (loginGone(theirSums)) return fail(RECVLOGIN);
  const parsedTheirs = theirSums.ok ? parseChecksumLines(theirSums.stdout) : null;
  if (!sums.ok || !parsedTheirs || !parsedTheirs.ok) {
    return mismatch(`the checksums could not be read (${!sums.ok ? sums.error : !theirSums.ok ? why(theirSums) : parsedTheirs && !parsedTheirs.ok ? parsedTheirs.error : 'no answer'})`);
  }
  const sumCmp = compareChecksums(withoutAddresses(sums.sums), withoutAddresses(parsedTheirs.sums));
  if (!sumCmp.ok) return mismatch(`checksums: ${sumCmp.text}`);

  const notMain = (r: { error?: string; stderr: string }) => fail(`The data reached ${machine} and matched, but ${machine} could not be made the main (${why(r)}). Press Push again.`);
  const capped = await receiverClient(inst, code, pem, { as: 'recv', suffix: 'cap', script: 'psql -X "$1" -v ON_ERROR_STOP=1 -tAq -c "$2"', args: [recvDsn(code, code.db, 'recv'), SHARD_CAP_DO_SQL], timeoutMs: MOVE_TIMING.clientMs });
  if (loginGone(capped)) return fail(RECVLOGIN);
  if (!capped.ok) return notMain(capped);
  const commit = `SET ROLE ${dbLogin.META_LOGIN};\n${raiseSql(code.machine, p.target, `${addressTableSql(code.host, code.port, pem, code.machine)}
DELETE FROM smdb_manager.addresses WHERE NOT (host = ${sqlLiteral(code.host)} AND port = ${Number(code.port)});
INSERT INTO smdb_manager.received (push_id, from_system_id, from_machine, generation) VALUES (${sqlLiteral(code.recv.id)}, ${sqlLiteral(p.systemId)}, ${sqlLiteral(machineNameOf(inst))}, ${p.target}) ON CONFLICT (push_id) DO NOTHING;
`)}`;
  const committed = await receiverClient(inst, code, pem, { as: 'meta', suffix: 'commit', script: 'psql -X "$1" -v ON_ERROR_STOP=1 -tAq', args: [recvDsn(code, code.db, 'meta')], timeoutMs: MOVE_TIMING.clientMs, input: commit });
  if (loginGone(committed)) return fail(RECVLOGIN);
  if (!committed.ok) return notMain(committed);
  return null;
}

/**
 * Y3 and ruling 4, after the commit: each receive login hands what it owns in the pushed database to the bot role and
 * drops what was granted to it; smdb_receive then loses its password and its other sessions. A failure is logged and
 * does not fail the push: the receiving machine's end repeats these steps.
 */
async function lastStep(inst: InstanceConfig, code: MoveCode, pem: string): Promise<void> {
  const user = inst.fleetDb!.user;
  const script = 'psql -X "$1" -v ON_ERROR_STOP=1 -q';
  const recv = await receiverClient(inst, code, pem, { as: 'recv', suffix: 'last', script, args: [recvDsn(code, code.db, 'recv')], timeoutMs: MOVE_TIMING.clientMs,
    input: `${clearOwnedSql(RECEIVE_ROLE, user)}ALTER ROLE ${RECEIVE_ROLE} PASSWORD NULL;\nSELECT pg_catalog.pg_terminate_backend(pid) FROM pg_catalog.pg_stat_activity WHERE usename = '${RECEIVE_ROLE}' AND pid <> pg_catalog.pg_backend_pid();\n` });
  if (!recv.ok) {
    console.warn(`[Switch] ${inst.displayName}: the receive login's password could not be removed after the push (${recv.error || lastLine(recv.stderr)}); the receiving machine removes the move code's logins at its own checks of receiving, and until its first check this move code's password still opens them`);
  }
  const meta = await receiverClient(inst, code, pem, { as: 'meta', suffix: 'last-meta', script, args: [recvDsn(code, code.db, 'meta')], timeoutMs: MOVE_TIMING.clientMs, input: clearOwnedSql(RECEIVE_META_ROLE, user) });
  if (!meta.ok) {
    console.warn(`[Switch] ${inst.displayName}: what the second receive login owns in the pushed database could not be handed to the bot's role after the push (${meta.error || lastLine(meta.stderr)}); the receiving machine does it when it ends receiving`);
  }
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
  const r = await workSql(t, db, `${CHECKSUM_SQL};`, MOVE_TIMING.verifyMs);
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
