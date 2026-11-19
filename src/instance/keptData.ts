/**
 * Kept data (NM31): Start on a new database sets a bot's database volume, live copy volume and data folder aside under
 * recorded names and gives the bot new ones; Put back brings a kept set into use again; Delete removes a kept set after
 * a checked dump and archive. Every operation records itself in the instance's keptOp before its first effect.
 */
import * as crypto from 'crypto';
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as containerManager from '../docker/containerManager';
import * as dockerClient from '../docker/dockerClient';
import * as envManager from '../env/manager';
import { getDataPath } from '../git/repoManager';
import { findAppCapabilities } from '../config/appCapabilities';
import { readDatabaseUrl } from '../config/databaseUrl';
import * as maintenance from './maintenance';
import * as fleetBackup from './fleetBackup';
import * as fleetReplica from './fleetReplica';
import * as fleetReplication from './fleetReplication';
import * as fleetSwitch from './fleetSwitch';
import * as dbLogin from './dbLogin';
import { claimFleetBackupBusy, isFleetBackupBusy, releaseFleetBackupBusy } from './fleetBackupGuards';
import { checkDumpInThrowaway, THROWAWAY_LABEL, Verdict } from './backupCheck';
import { backupDir, parseDfFreeKb, stampOf, validateDumpMeta } from './backupFiles';
import { generationBefore, GenRow, parseRestoreState, RESTORE_STATE_READ, RestoreState } from './switchSql';
import { InstanceConfig, KeptDataSet, KeptOpRecord, KeptStep } from '../types';

const NOTHING = '; nothing was changed';
const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

// ─── Texts (section 10) ───

const NEW_START = 'Start on a new database';
const NA_LEAD = `The bot's Off is not confirmed because its database has no ${dbLogin.MANAGER_DB_ROLE} role, so the bot's login could not be blocked`;
const FOLDER_CLAUSE = (certs: boolean) => `maintenance.json${certs ? ', and the join\'s certificate files,' : ''}`;
const TAIL_BOOT = (certs: boolean) => `Its new data folder holds ${FOLDER_CLAUSE(certs)} so its next start is a maintenance boot`;
const OTHER_FILES = 'the other files of the old folder, its .env among them, stay in the kept folder.';

const listText = (items: string[]) => (items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`);

/** The open-record text of every operation: why it stopped, the steps done, and what the operator can do. */
function openText(lead: string, reason: string, done: string[], next: string): string {
  return `${lead}: ${reason}. Done so far: ${done.length ? done.join(', ') : 'nothing'}. ${next}`;
}

/** What one status read says of a live copy put back. `unknown`: the probe failed and docker did not say the container is stopped. */
export type CopyNote = { streams: string } | { down: string } | { stopped: string } | { unknown: string };

export const KEPT_TEXT = {
  // Admission
  aOff: `${NEW_START} needs the bot Off: choose Off in its State window first${NOTHING}`,
  aUnsettled: (lastError: string) => `The bot's change to Off is not confirmed yet (${lastError}), so its database may still be in use${NOTHING}`,
  aRuns: `The bot's container runs although its State is Off; choose Off again to stop it${NOTHING}`,
  aJson: `This bot keeps its data in files and uses no database, so there is no database to start again${NOTHING}`,
  aNoFile: `This app does not declare the file its maintenance state is saved in, so the manager cannot make its next start a maintenance boot${NOTHING}`,
  aLane: (op: string) => `${/^[aeiou]/i.test(op) ? 'An' : 'A'} ${op} of this instance was cut short; run it again first${NOTHING}`,
  aSeed: `A live copy is being seeded on this instance; wait for it to finish${NOTHING}`,
  aSwitch: (what: 'hand-over' | 'push' | 'receive' | 'take-over') => `The database is in a ${what} that has not finished, or another database has replaced it or claims the same generation; settle that in the Move section first${NOTHING}`,
  aBoth: `This instance runs the main database and also holds a live copy; remove or adopt the copy first${NOTHING}`,
  aFence: (stuck: string) => `${stuck}; lift it first${NOTHING}`,
  aUrlEmpty: `The manager holds no Database URL for this bot (the bot may read one from its own .env); set it in the Env editor first${NOTHING}`,
  aUrlHost: (host: string, container: string) => `The Database URL reaches this database through its public address ${host}, and the new database has no public address until replication is enabled on it; set the URL to the container name ${container} first${NOTHING}`,
  aUrlOther: (host: string, container: string) => `The Database URL names ${host}, not this bot's managed database ${container}; set the URL to the container name ${container} in the Env editor first${NOTHING}`,
  aNoPass: `The Database URL holds no password for the bot's login, so the new database could not take the same login${NOTHING}`,
  aSharers: (names: string[]) => `${listText(names)} ${names.length > 1 ? 'use' : 'uses'} this database and ${names.length > 1 ? 'run' : 'runs'}; choose Off for ${names.length > 1 ? 'each' : 'it'} first${NOTHING}`,
  aSharersUnknown: (names: string[]) => `Docker did not say whether ${listText(names)}, which ${names.length > 1 ? 'use' : 'uses'} this database, ${names.length > 1 ? 'are' : 'is'} running${NOTHING}`,
  aFolder: (dataDir: string, err: string, end = NOTHING) => `The bot's data folder ${dataDir} could not be read (${err})${end}`,
  aNamesVolume: (v: string) => `The volume ${v} already exists, so that name is taken${NOTHING}; try again`,
  aNamesFolder: (f: string) => `The folder ${f} already exists, so that name is taken${NOTHING}; try again`,
  aDocker: (v: string, end = NOTHING) => `Docker did not say whether the volume ${v} exists${end}; try again`,
  aGen: (g: number) => `The bot's database holds main generation ${g}, raised by a switch, a push or a restore, so a switch notice up to generation ${g} may have been posted to the owner. A new database starts at generation 1, and a bot that reads a notice above that stays stopped as replaced. Nothing was changed. ${NEW_START} works on a database of generation 1 or without a generation; for this one it needs a manager change that gives the new database a generation above the kept one.`,
  aGenUnknown: (err: string) => `The manager can't confirm the database's main generation (${err}), and a new database below it would leave the bot stopped as replaced${NOTHING}`,
  aGenDown: `The bot's database is not running, so its main generation cannot be read; choose Off again, which starts it alone${NOTHING}`,
  aRecord: (err: string) => `${NEW_START} was not recorded, so nothing was changed: ${err}`,
  aNaAdmin: `The bot's Off is not confirmed, and its database now has a ${dbLogin.MANAGER_DB_ROLE} role that is a superuser and can log in; choose Off again, which uses it to block the bot's login${NOTHING}`,
  aNaAdminPlain: `The bot's Off is not confirmed, and its database now has a ${dbLogin.MANAGER_DB_ROLE} role that cannot log in or is not a superuser, so the manager cannot use it to block the bot's login; ${NEW_START} and Put back accept an unconfirmed Off only on a database with no ${dbLogin.MANAGER_DB_ROLE} role. Make ${dbLogin.MANAGER_DB_ROLE} a superuser that can log in, or remove it, then choose Off again${NOTHING}`,
  aNaSessions: (user: string, a: number, b: number) => `${NA_LEAD}, and two reads one second apart found open sessions of the bot's role ${user} on the database (${a}, then ${b}). The manager does not end them; try again once they are closed${NOTHING}`,
  aNaStandby: `${NA_LEAD}, and the database runs in recovery as a live copy, so the manager does not stop it as this bot's main${NOTHING}`,
  aNaNotSuper: (user: string) => `${NA_LEAD}, and the bot's role ${user} is not a superuser of that database, so the manager does not read the database as that role${NOTHING}`,
  aNaRead: (user: string, err: string) => `${NA_LEAD}, and the manager could not read the database as the bot's role ${user} over the container's socket (${err}), so it can't confirm that nothing uses it${NOTHING}`,
  aNaDown: `${NA_LEAD}, and the database is not running, so the manager cannot check it as the bot's role; choose Off again, which starts it alone${NOTHING}`,
  aSslUnknown: (err: string) => `The manager can't confirm whether the bot's database runs with TLS (${err}); the new database gets TLS only when this one has it${NOTHING}`,

  // Start on a new database
  nDoneMain: (p: { old: string; outDir: string; newVolume: string; certs: boolean; replication: boolean; sharers: string | null; tls?: boolean }) =>
    `Started on a new database. The volume ${p.old} and the data folder ${p.outDir} are kept unchanged under Kept data. The new database runs alone on the volume ${p.newVolume}, with data checksums on${p.tls ? ', TLS on as the kept database had it (with a certificate of its own, which Enable replication replaces),' : ''} and the bot's login open; the Database URL is unchanged. The bot is stopped and its State is Running. ${TAIL_BOOT(p.certs)}; ${OTHER_FILES}`
    + (p.replication ? ' Copies on other machines still follow the kept database: enable replication here, then Copy join code and Add a live copy on each machine.' : '')
    + (p.sharers ? ` ${p.sharers} also use this database and still have their old data folders; run ${NEW_START} on each before you start it.` : ''),
  nDoneFolder: (p: { outDir: string; certs: boolean }) =>
    `Started on a new data folder. The data folder ${p.outDir} is kept unchanged under Kept data; the database is not changed. The bot is stopped and its State is Running. ${TAIL_BOOT(p.certs)}; ${OTHER_FILES}`,
  nDoneCopy: (p: { volume: string; outDir: string; certs: boolean }) =>
    `Started on a new data folder. This machine's live copy (volume ${p.volume}) and the data folder ${p.outDir} are kept unchanged under Kept data, and this machine holds no live copy now; Add a live copy makes a new one on a new volume. The main keeps this copy's slot and address until the slot is dropped there. The bot is stopped and its State is Running. ${TAIL_BOOT(p.certs)}.`,
  /** `gone`: the data folder was found missing (nGone); Put back then leaves it missing, and a folder start has no database to return. */
  nOpen: (reason: string, done: string[], gone?: NewStartVariant) => openText(`${NEW_START} stopped before it finished`, reason, done, !gone
    ? 'Run it again to go on, or Put back to return to the earlier database and data folder; until one of them finishes, the bot stays stopped and Start is refused.'
    : `Run it again to go on, or Put back to ${gone === 'folder' ? 'close this' : 'return to the earlier database'}; the data folder stays missing. Until one of them finishes, the bot stays stopped and Start is refused.`),
  nNotOurs: (folder: string, names: string[]) => `the data folder ${folder} holds ${names.slice(0, 5).join(', ')} that this start did not write, so the manager can't confirm which folder is the bot's`,
  nChecksums: 'the new database does not have data checksums on, so it was not made from an empty volume by this start',
  nTls: (why: string) => `TLS could not be turned on for the new database (${why}); the kept database had it on, and a Database URL that asks for TLS does not connect without it`,
  nTlsUnknown: (why: string) => `the manager can't confirm that TLS is on for the new database (${why}); the kept database had it on, and a Database URL that asks for TLS does not connect without it`,
  /** `unknown`: the reload got no answer, so whether it happened is not known. */
  nTlsOff: (why: string, reload?: string, unknown = false) => `TLS could not be turned on for the new database (${why}), so the manager turned it off again and set its certificate aside${!reload ? ''
    : unknown ? `; the manager can't confirm the configuration was reloaded after that (${reload}), so the running database may still show ssl on until its next reload or restart`
    : `; the configuration was not reloaded after that (${reload}), so the running database still shows ssl on until its next reload or restart`}; the new database runs without TLS while the Database URL asks for TLS, and Run it again makes a fresh certificate`,
  /** `unknown`: the renames got no answer, so whether they happened is not known. */
  nTlsAside: (why: string, aside: string, unknown = false) => `TLS could not be turned on for the new database (${why}), so the manager turned it off again, but ${unknown ? 'the manager can\'t confirm its certificate was set aside' : 'its certificate could not be set aside'} (${aside}); the new database runs without TLS while the Database URL asks for TLS`,
  nTlsStuck: (why: string, reset: string) => `TLS could not be turned on for the new database (${why}), and turning it off again failed (${reset}), so ssl may still be saved beside a certificate the database cannot load: a restart of the new database may fail, and Put back returns the kept database`,
  nMount: (mounts: string[], volume: string) => `docker shows ${mounts.length ? mounts.join(', ') : 'no mount'} at the database's data folder, not the new volume ${volume}, so the manager did not turn TLS on`,
  nMountGone: 'the database container is gone (docker says no such container), so the manager did not turn TLS on',
  nMountUnknown: (err: string) => `docker did not say which volume the database container runs on (${err}), so the manager did not turn TLS on`,
  nGone: (dataDir: string) => `the data folder ${dataDir} is missing, so nothing was set aside; put the folder back there and run it again`,
  nRuns: (name: string) => `the bot's container (or its database or copy container) runs although this has not finished; stop it in a shell with docker stop ${name}, then run it again`,
  nRunsUnnamed: (project: string) => `the bot's container (or its database or copy container) runs although this has not finished, and the manager could not name it; stop the app container of ${project} in a shell, then run it again`,

  // Put back and the reverse
  pNoSet: (set: string) => `This bot has no kept data ${set}${NOTHING}`,
  pCross: (setHolds: 'db' | 'copy') => (setHolds === 'db'
    ? `The kept data holds a main database, and this instance holds a live copy now; remove the copy with Remove replica first${NOTHING}`
    : `The kept data holds a live copy, and this instance holds a main database now; decommission or move the main first${NOTHING}`),
  pUrl: (container: string) => `The Database URL no longer names this bot's managed database ${container}, so the bot would not use the database put back; set it back in the Env editor first${NOTHING}`,
  pGoneVolume: (v: string) => `The kept volume ${v} is missing, so nothing was put back`,
  pGoneFolder: (f: string) => `The kept folder ${f} is missing, so nothing was put back`,
  /** `missing`: a reverse that found the data folder removed outside and left it so; `asideFolder` then was never in use. `appeared`: a folder is there now. */
  pDone: (p: { date: string; volume?: string; copyVolume?: string; folder?: string; missing?: string; appeared?: boolean; asideVolume?: string; asideFolder?: string; copy?: CopyNote; orderText: string }) => {
    const back = [p.volume ? `the volume ${p.volume}` : p.copyVolume ? `the live copy on the volume ${p.copyVolume}` : '', p.folder ? `the data folder ${p.folder}` : ''].filter(Boolean);
    const aside = [p.asideVolume ? `the volume ${p.asideVolume}` : '', p.asideFolder && !p.missing ? `the folder ${p.asideFolder}` : ''].filter(Boolean);
    const copy = !p.copy ? '' : 'streams' in p.copy ? ` The live copy runs and streams from ${p.copy.streams}.`
      : 'stopped' in p.copy ? ` The live copy does not run: ${p.copy.stopped}.`
      : 'unknown' in p.copy ? ` The manager can't confirm that the live copy runs: ${p.copy.unknown}.`
      : ` The live copy runs but does not stream: ${p.copy.down}.`;
    const missing = !p.missing ? '' : p.appeared ? `the data folder ${p.missing} was missing when this ran; the folder there now was not put there by this Put back`
      : `the data folder ${p.missing} was already missing and still is`;
    const lead = !missing ? `Put back. The kept data of ${p.date} is in use again: ${back.join(' and ')}.`
      : back.length ? `Put back. The kept data of ${p.date} is in use again: ${back.join(' and ')}; ${missing}.`
      : `Put back: ${missing}.`;
    return lead
      + (aside.length ? ` What was in use (${aside.join(' and ')}) is kept unchanged under Kept data.` : '')
      + (p.missing && p.asideFolder ? ` The folder ${p.asideFolder} was not brought in and stays where it was, under Kept data.` : '')
      + `${copy} ${p.orderText}`;
  },
  pOpen: (reason: string, done: string[], undo = false) => openText('Put back stopped before it finished', reason, done, undo
    ? 'Run it again to finish going back to the earlier data; until it finishes, the bot stays stopped and Start is refused.'
    : 'Run it again to go on, or Put back again to reverse it; until one of them finishes, the bot stays stopped and Start is refused.'),
  uNothing: (orderText: string) => `Put back before the earlier data was set aside: the earlier database and data folder stay in use. ${orderText}`,
  pOff: `Put back needs the bot Off: choose Off in its State window first${NOTHING}`,
  pEmpty: (set: string) => `The kept data ${set} holds no database, live copy or data folder, so there is nothing to put back${NOTHING}`,
  pNamesSet: (set: string) => `The kept data ${set} already exists, so that name is taken${NOTHING}; try again`,
  pOrderRefused: (err: string) => `The Off order was refused: ${err}`,
  cNotSuper: (user: string) => `the live copy's role ${user} is not a superuser there, so the manager did not read it as that role`,
  cRead: (user: string, err: string) => `the read as the live copy's role ${user} failed too (${err})`,
  cName: (user: string) => `the live copy's role name ${user} is not one the manager reads as, so it did not read the copy as that role`,

  // Delete
  xCurrent: (v: string) => `The kept volume ${v} is the one this bot uses now; nothing was deleted`,
  xInUse: (v: string, names: string) => `The kept volume ${v} is mounted by ${names}; nothing was deleted`,
  xPath: (f: string) => `The kept folder ${f} is not beside the bot's data folder, so the manager does not delete it; nothing was deleted`,
  xDropped: (v: string, folder: string | null) => ` The kept volume ${v} no longer exists (docker says no such volume), so the set now holds only ${folder ? `the folder ${folder}` : 'nothing'}.`,
  xDisk: (freeMb: number, needMb: number) => `The disk that holds Docker's volumes has ${freeMb} MB free, and a scratch copy of the kept database needs ${needMb} MB (its size, plus 1 GB kept free for the live database); nothing was deleted`,
  xDump: (err: string): string => `${KEPT_TEXT.xDumpFailed(err)} Run Delete again, or Keep it.`,
  xDumpFailed: (err: string) => `The dump of the kept database failed (${err}), so nothing was deleted.`,
  xNoWork: (v: string) => ` The database has no ${dbLogin.WORK_LOGIN} login: it was made before the manager's own logins existed, so the manager cannot dump it, and it stays under Kept data. To remove it by hand without changing it: choose Keep it, copy the volume ${v} to a new volume (mounting ${v} read-only), start Postgres on the copy only, dump the copy as the database's own superuser and check that dump, then remove the volume with docker volume rm ${v}; Delete then removes the rest of this kept data after its own checks.`,
  xCheck: (file: string, reason: string) => `The dump ${file} did not restore cleanly in a throwaway database (${reason}), so nothing was deleted; the dump stays with the backups`,
  xArchive: (err: string) => `The kept folder could not be archived (${err}), so nothing was deleted`,
  xArchCheck: (file: string, difference: string, dir: string) => `The archive ${file} does not match the kept folder (${difference}), so nothing was deleted; the archive stays in ${dir}`,
  xPartial: (p: { volume?: string; folder?: string; err: string; dump?: string; archive?: string }) => {
    const stay = [p.dump ? `the dump ${p.dump}` : '', p.archive ? `the archive ${p.archive}` : ''].filter(Boolean);
    const what = p.volume ? `the volume ${p.volume}` : `the folder ${p.folder}`;
    return `Delete stopped while it removed the kept data: ${what} could not be removed (${p.err}). Run Delete again to finish`
      + (stay.length ? `; ${stay.join(' and ')} ${stay.length > 1 ? 'stay' : 'stays'}.` : '.');
  },
  xDone: (p: { date: string; volume?: string; folder?: string; dump?: string; archive?: string }) => {
    const removed = [p.volume ? `the volume ${p.volume}` : '', p.folder ? `the folder ${p.folder}` : ''].filter(Boolean);
    const checks = [p.dump ? `the dump ${p.dump} of a copy of it restored cleanly` : '', p.archive ? `the archive ${p.archive} matched the folder` : ''].filter(Boolean);
    return `Deleted the kept data of ${p.date}: ${removed.join(' and ')} ${removed.length > 1 ? 'were' : 'was'} removed after ${checks.join(' and ')}; ${checks.length > 1 ? 'both stay' : 'it stays'} in this manager's backups folder.`;
  },
  xKept: (p: { date: string; dump?: string; archive?: string; rejected?: string[] }) => {
    const made = [p.dump ? `the dump ${p.dump}` : '', p.archive ? `the archive ${p.archive}` : '', ...(p.rejected ?? []).map(r => `the rejected archive ${r}`)].filter(Boolean);
    const list = listText(made);
    return `Kept: the kept data of ${p.date} was not deleted.` + (made.length ? ` ${list.charAt(0).toUpperCase()}${list.slice(1)} made so far ${made.length > 1 ? 'stay' : 'stays'} in the backups folder.` : '');
  },
  xRunning: 'Delete is running on this kept data; wait for it to end, then read the outcome here',
  xNoRec: `This bot has no open Delete to run again: it was stopped with Keep it or finished${NOTHING}`,
  xNoAbandon: 'Delete already began removing the kept data, so it can only be run again to finish',
  xOpen: (reason: string, done: string[], keepIt: boolean) => openText('Delete stopped before it finished', reason, done,
    keepIt ? 'Run it again to go on, or Keep it to stop here.' : 'Run it again to go on.'),
  xShared: (v: string, reason: string) => `The kept volume ${v} is not only this kept data's: ${reason}; nothing was deleted`,
  xPsUnknown: (v: string, err: string) => `Docker did not say which containers mount the kept volume ${v} (${err}); nothing was deleted; try again`,
  xNoKeep: `This bot has no open Delete to stop${NOTHING}`,
  xStays: (p: { dump?: string; archive?: string }) => {
    const stay = [p.dump ? `the dump ${p.dump}` : '', p.archive ? `the archive ${p.archive}` : ''].filter(Boolean);
    return `; nothing was deleted${stay.length ? `, and ${stay.join(' and ')} ${stay.length > 1 ? 'stay' : 'stays'} in the backups folder` : ''}`;
  },
  xDroppedDone: (v: string) => ` The kept volume ${v} no longer existed (docker said no such volume), so only the folder was deleted.`,
  xDroppedSet: (v: string) => `The kept volume ${v} no longer exists (docker says no such volume), and the set named nothing else, so it was removed from Kept data; nothing was deleted.`,
  xDoneEmpty: (date: string) => `Deleted the kept data of ${date}: it held no volume and no folder to remove.`,
};

/** T-N-OPEN's step words, in order, with the step whose save marks each done. */
const NEW_START_DONE: Array<{ words: string; after: KeptStep; part: 'store' | 'db' | 'tls' | 'all'; copy?: string }> = [
  { words: 'the database was stopped', after: 'db-stopped', part: 'store', copy: 'the live copy was stopped' },
  { words: 'its service was taken out of the compose', after: 'db-out', part: 'store' },
  { words: 'the earlier data was recorded as kept', after: 'swapped', part: 'all' },
  { words: 'the new data folder was made', after: 'folder', part: 'all' },
  { words: 'the data folder was set aside', after: 'folder', part: 'all' },
  { words: 'the new data folder is in use', after: 'folder', part: 'all' },
  { words: 'the new database\'s service was written', after: 'db-in', part: 'db' },
  { words: 'the new database started', after: 'db-up', part: 'db' },
  { words: 'TLS is on', after: 'db-up', part: 'tls' },
  { words: 'its login is open', after: 'login', part: 'db' },
];
const NEW_START_ORDER: KeptStep[] = ['recorded', 'db-stopped', 'db-out', 'swapped', 'folder', 'db-in', 'db-up', 'login'];

/** The step words of an open new-start record, from its last saved step. */
export function newStartDone(rec: Pick<KeptOpRecord, 'step' | 'parts' | 'keptSsl'>): string[] {
  const at = NEW_START_ORDER.indexOf(rec.step);
  const store = rec.parts.includes('db') || rec.parts.includes('copy');
  const shown = (part: 'store' | 'db' | 'tls' | 'all') => part === 'all' || (part === 'store' ? store
    : part === 'tls' ? rec.parts.includes('db') && rec.keptSsl === true : rec.parts.includes('db'));
  return NEW_START_DONE
    .filter(d => shown(d.part) && NEW_START_ORDER.indexOf(d.after) <= at)
    .map(d => (d.copy && !rec.parts.includes('db') ? d.copy : d.words));
}

// ─── The frame ───

export type KeptAnswer =
  | { success: true; text: string; warning?: string }
  | { success: false; status: number; error: string; open?: true };

const refuse = (status: number, error: string): KeptAnswer => ({ success: false, status, error });

export const NEW_START_OP = 'new-database';
export const PUT_BACK_OP = 'put-back';
const busyText = (op: string) => `Operation '${op}' already in progress`;
const R8 = "The env store for this instance cannot be read, so the manager can't tell which database the bot uses; nothing was changed";
const R11 = 'Docker did not say whether the bot is running, so nothing was changed; retry in a moment';
const SLOT_TEXT = 'A backup or restore operation is in progress on this database - wait for it to finish';

/** The kept operation running in this process per bot; gone after a restart, when nothing runs. */
const keptRunning = new Map<string, string>();

export function keptRunningOp(botId: string): string | null {
  return keptRunning.get(botId) ?? null;
}

type KeptKey = Pick<KeptOpRecord, 'op' | 'set' | 'stamp'>;

/** The key of the record the bot's run in this process opened its run on; gone when the route ends. */
const keptRunKeys = new Map<string, KeptKey>();

/**
 * A run's first act on its record: one compare-and-save that drops the last stop's reason, so the page reads the
 * record as running until the run writes its own stop. Answers KEPT_RECORD_CLOSED when the record no longer matches.
 */
function beginRun(botId: string, key: KeptKey): string | null {
  const r = containerManager.saveKeptOpIf(botId, key, { lastError: undefined, folderGone: undefined });
  if (!r) keptRunKeys.set(botId, key);
  return r;
}

/** A route's catch: a run that began and then threw saves the reason on its record while that record is still open. */
function recordUnexpected(botId: string, op: string, err: unknown): void {
  const key = keptRunKeys.get(botId);
  if (!key) return;
  try {
    containerManager.saveKeptOpIf(botId, key, { lastError: `an unexpected error (${errText(err)})` });
  } catch (saveErr) {
    console.error(`[KeptData] ${botId}: the stop of ${op} could not be recorded: ${errText(saveErr)}`);
  }
}

/** Claims the bot for one kept operation, check and set in one synchronous segment; false while another holds it. */
function claimKeptRunning(botId: string, op: string): boolean {
  if (keptRunning.has(botId)) return false;
  keptRunning.set(botId, op);
  return true;
}

export type KeptNames = { stamp: string; startedAt: string; outDir: string; inDir: string; newVolume: string };

/** The names a Start on a new database minted at `at` sets aside and brings in. */
export function newStartNames(inst: Pick<InstanceConfig, 'sanitizedName'>, dataDir: string, at: number): KeptNames {
  const stamp = stampOf(at);
  return {
    stamp,
    startedAt: new Date(at).toISOString(),
    outDir: `${dataDir}.kept-${stamp}`,
    inDir: `${dataDir}.new-${stamp}`,
    newVolume: `${inst.sanitizedName}-fleet-postgres-data-${stamp}`,
  };
}

type StoredEnv = { env: Record<string, string>; url: string } | { error: string };

/** The merged env as maintenanceKind reads it (record under the store), or R8 when the store or its URL key cannot be read. */
function storedEnv(inst: InstanceConfig): StoredEnv {
  const urlKey = findAppCapabilities(inst.sourceUrl)?.companionDb?.env.url;
  let status: ReturnType<typeof envManager.getEnvVarsWithStatus>;
  try { status = envManager.getEnvVarsWithStatus(inst.id); } catch { return { error: R8 }; }
  if (status.corrupt || (urlKey && status.undecryptable.includes(urlKey))) return { error: R8 };
  const env: Record<string, string> = { ...(inst.envVars || {}), ...status.vars };
  for (const key of status.undecryptable) env[key] = '';
  return { env, url: urlKey ? (env[urlKey] || '').trim() : '' };
}

// ─── Admission of Start on a new database (3.2) ───

export type NewStartVariant = 'main' | 'copy' | 'folder';

/** The variant a Start on a new database would run now, read as its admission reads it; null when admission refuses on the settings. */
export function newStartVariantOf(inst: InstanceConfig): NewStartVariant | null {
  const read = storedEnv(inst);
  if ('error' in read) return null;
  const kind = maintenance.maintenanceKind(inst, read.env);
  if (kind === 'json' || kind === 'none' || !findAppCapabilities(inst.sourceUrl)?.hooks?.stateFile) return null;
  return kind === 'database' ? 'main' : kind === 'copy' ? 'copy' : 'folder';
}
export type NewStartAdmitted = { ok: true; record: KeptOpRecord; resumed: boolean; slot: boolean };
export type NewStartAdmission = NewStartAdmitted | { ok: false; answer: KeptAnswer };

const no = (status: number, error: string): NewStartAdmission => ({ ok: false, answer: refuse(status, error) });

function switchWord(inst: InstanceConfig): 'hand-over' | 'push' | 'receive' | 'take-over' | null {
  const db = inst.fleetDb;
  if (db?.handover) return db.handover.mode === 'push' ? 'push' : 'hand-over';
  if (db?.receive) return 'receive';
  if (db?.pushBroken) return 'push';
  if (inst.fleetDbReplica?.takeover) return 'take-over';
  if (db?.replacedBy || db?.mainConflict) return 'take-over';
  return null;
}

/**
 * What Invariant A reads at A7: the open record (a resume passes by its `noAdminOff`), or for a fresh press whether
 * the instance's kind is 'database'.
 */
export type NoAdminGate = { open: KeptOpRecord } | { database: boolean };

/**
 * A6 to A8: the Off order settled (unless `skipSettled`), or unsettled only for the missing dbm_admin under `na`, and
 * the app stopped. A pass answers `na`: the Off's orderedAt when a fresh press passed by Invariant A, else null.
 */
async function offAndStopped(botId: string, inst: InstanceConfig, skipSettled: boolean, offText: string = KEPT_TEXT.aOff, na?: NoAdminGate): Promise<{ status: number; error: string } | { runs: true } | { na: string | null }> {
  const m = maintenance.maintenanceOf(inst);
  if (m.state !== 'off') return { status: 409, error: offText };
  let admitted: string | null = null;
  if (!skipSettled && !m.settled) {
    const accepted = !!na && maintenance.noAdminOff(m) && ('open' in na ? na.open.noAdminOff === m.orderedAt : na.database);
    if (!accepted) return { status: 409, error: KEPT_TEXT.aUnsettled(m.lastError || 'the order has not finished') };
    if (!('open' in na!)) admitted = m.orderedAt;
  }
  const app = await containerManager.appContainerRunning(botId);
  if (app === null) return { status: 409, error: R11 };
  return app ? { runs: true } : { na: admitted };
}

/** T-N-RUNS for the running app container: its id as docker lists it, else the compose project with no command. */
async function appRunsText(inst: InstanceConfig): Promise<string> {
  const id = await containerManager.runningAppContainer(inst);
  return typeof id === 'string' ? KEPT_TEXT.nRuns(id) : KEPT_TEXT.nRunsUnnamed(inst.sanitizedName);
}

/** A15: the other bots on this database, stopped and not busy; the refusal otherwise. */
async function sharersRefusal(inst: InstanceConfig, url: string): Promise<string | null> {
  const name = (id: string) => containerManager.getBot(id)?.displayName ?? id;
  const search = await fleetBackup.runningDatabaseSharers(inst, url);
  const unchecked = search.unchecked.filter(id => id !== inst.id);
  const running: string[] = [];
  const unknown = unchecked.map(name);
  for (const b of search.bots) {
    if (b.id === inst.id) continue;
    if (containerManager.isBotBusy(b.id)) { running.push(b.displayName); continue; }
    const live = await containerManager.liveContainerNames(b.id);
    if (live === null) unknown.push(b.displayName);
    else if (live.length > 0) running.push(b.displayName);
  }
  if (running.length) return KEPT_TEXT.aSharers(running);
  if (unknown.length) return KEPT_TEXT.aSharersUnknown(unknown);
  return null;
}

// ─── The reads as the bot's own role, on a database with no dbm_admin (NM34 5.1) ───

const SU_HEAD = `BEGIN TRANSACTION READ ONLY;
SELECT coalesce((SELECT rolsuper FROM pg_catalog.pg_roles WHERE rolname = current_user), false) AS su \\gset
\\echo :su
\\if :su
`;
const SESSIONS_COUNT = "count(*) FROM pg_catalog.pg_stat_activity WHERE usename = current_user AND backend_type = 'client backend' AND pid <> pg_catalog.pg_backend_pid()";

/** S1, on postgres: superuser, recovery, dbm_admin, two session counts 1 s apart, and the restore record when it is a plain table. */
export const OWNER_CLUSTER_READ = `${SU_HEAD}SELECT 'recovery|' || pg_catalog.pg_is_in_recovery()::text;
SELECT 'admin|' || coalesce((SELECT (rolsuper AND rolcanlogin)::text FROM pg_catalog.pg_roles WHERE rolname = '${dbLogin.MANAGER_DB_ROLE}'), 'missing');
SELECT 'sessions|' || ${SESSIONS_COUNT};
SELECT 'restorekind|' || coalesce((SELECT relkind::text FROM pg_catalog.pg_class WHERE oid = pg_catalog.to_regclass('smdb_manager.restore_state')), '-');
SELECT coalesce((SELECT relkind = 'r' FROM pg_catalog.pg_class WHERE oid = pg_catalog.to_regclass('smdb_manager.restore_state')), false) AS rs_table \\gset
\\if :rs_table
SELECT 'restore|' || (${RESTORE_STATE_READ});
\\endif
ROLLBACK;
SELECT pg_catalog.pg_sleep(1);
BEGIN TRANSACTION READ ONLY;
SELECT 'sessions2|' || ${SESSIONS_COUNT};
ROLLBACK;
\\endif
`;

/** S2, in the bot's database: the generation row as the admin read gives it. */
export const OWNER_GEN_READ = `BEGIN TRANSACTION READ ONLY;\n${fleetSwitch.ADMIN_GEN_READ}ROLLBACK;\n`;

/** S3, on postgres of a live copy: superuser, recovery and the WAL receiver's status. */
export const OWNER_COPY_READ = `${SU_HEAD}SELECT 'copy|' || pg_catalog.pg_is_in_recovery()::text || '|' || coalesce((SELECT status FROM pg_catalog.pg_stat_wal_receiver LIMIT 1), '');
\\endif
ROLLBACK;
`;

export type OwnerCluster = { superuser: false } | {
  superuser: true; recovery: boolean; admin: 'missing' | 'usable' | 'unusable'; sessions: [number, number];
  restore: RestoreState | null | { notTable: string } | undefined;
};
export type OwnerCopy = { superuser: false } | { superuser: true; recovery: boolean; status: string };
export type OwnerFailure = { ok: false; refused: string } | { ok: false; error: string };

const readLines = (stdout: string) => stdout.split('\n').map(l => l.trim()).filter(Boolean);

/** S1's answer; undefined unless it is exactly `f`, or `t` and the lines in their order. */
export function parseOwnerClusterRead(stdout: string): OwnerCluster | undefined {
  const lines = readLines(stdout);
  if (lines.length === 1 && lines[0] === 'f') return { superuser: false };
  if (lines[0] !== 't') return undefined;
  const recovery = /^recovery\|(true|false)$/.exec(lines[1] ?? '');
  const admin = /^admin\|(missing|true|false)$/.exec(lines[2] ?? '');
  const first = /^sessions\|(0|[1-9]\d*)$/.exec(lines[3] ?? '');
  const kind = /^restorekind\|(.)$/.exec(lines[4] ?? '');
  if (!recovery || !admin || !first || !kind) return undefined;
  let next = 5;
  let restore: RestoreState | null | { notTable: string } | undefined;
  if (kind[1] === 'r') {
    const line = /^restore\|(.*)$/.exec(lines[5] ?? '');
    if (!line) return undefined;
    restore = parseRestoreState(line[1]);
    next = 6;
  } else restore = kind[1] === '-' ? null : { notTable: kind[1] };
  const second = /^sessions2\|(0|[1-9]\d*)$/.exec(lines[next] ?? '');
  if (!second || lines.length !== next + 1) return undefined;
  return {
    superuser: true, recovery: recovery[1] === 'true', admin: admin[1] === 'missing' ? 'missing' : admin[1] === 'true' ? 'usable' : 'unusable',
    sessions: [Number(first[1]), Number(second[1])], restore,
  };
}

/** S3's answer; undefined unless it is exactly `f`, or `t` and the copy line. */
export function parseOwnerCopyRead(stdout: string): OwnerCopy | undefined {
  const lines = readLines(stdout);
  if (lines.length === 1 && lines[0] === 'f') return { superuser: false };
  if (lines.length !== 2 || lines[0] !== 't') return undefined;
  const m = /^copy\|(true|false)\|(.*)$/.exec(lines[1]);
  return m ? { superuser: true, recovery: m[1] === 'true', status: m[2] } : undefined;
}

/** One script as the bot's role over the container's socket; a name botRoleRefusal refuses starts no process. */
async function ownerRead(container: string, user: string, db: string, script: string): Promise<{ ok: true; stdout: string } | OwnerFailure> {
  const bad = dbLogin.botRoleRefusal(user);
  if (bad) return { ok: false, refused: bad };
  const r = await fleetSwitch.runGuarded('docker', dbLogin.ownerReadArgs(container, user, db), { input: script, timeoutMs: fleetSwitch.SWITCH_TIMING.readMs });
  return r.ok ? { ok: true, stdout: r.stdout } : { ok: false, error: r.error || 'psql failed with no message' };
}

const answered = (stdout: string) => `the read answered '${readLines(stdout).pop() ?? ''}'`;

export async function readOwnerCluster(container: string, user: string): Promise<{ ok: true; read: OwnerCluster; stdout: string } | OwnerFailure> {
  const r = await ownerRead(container, user, 'postgres', OWNER_CLUSTER_READ);
  if (!r.ok) return r;
  const read = parseOwnerClusterRead(r.stdout);
  return read ? { ok: true, read, stdout: r.stdout } : { ok: false, error: answered(r.stdout) };
}

export async function readOwnerGeneration(container: string, user: string, db: string): Promise<{ ok: true; row: GenRow | null } | OwnerFailure> {
  const r = await ownerRead(container, user, db, OWNER_GEN_READ);
  return r.ok ? fleetSwitch.parseAdminGenRead(r.stdout) : r;
}

export async function readOwnerCopy(container: string, user: string): Promise<{ ok: true; read: OwnerCopy } | OwnerFailure> {
  const r = await ownerRead(container, user, 'postgres', OWNER_COPY_READ);
  if (!r.ok) return r;
  const read = parseOwnerCopyRead(r.stdout);
  return read ? { ok: true, read } : { ok: false, error: answered(r.stdout) };
}

/** S4, on postgres: the server's ssl setting, which any role may read. */
export const OWNER_SSL_READ = "BEGIN TRANSACTION READ ONLY;\nSELECT 'ssl|' || pg_catalog.current_setting('ssl');\nROLLBACK;\n";

/** A21's answer: exactly one line, `on` or `off` (admin) or `ssl|on` or `ssl|off` (S4); undefined otherwise. */
export function parseKeptSsl(stdout: string, from: 'admin' | 'owner'): boolean | undefined {
  const lines = readLines(stdout);
  if (lines.length !== 1) return undefined;
  const m = (from === 'admin' ? /^(on|off)$/ : /^ssl\|(on|off)$/).exec(lines[0]);
  return m ? m[1] === 'on' : undefined;
}

/** A21: the kept database's ssl, read live as dbm_admin, or as the bot's role (S4) on a database with no dbm_admin. */
export async function readKeptSsl(db: NonNullable<InstanceConfig['fleetDb']>, opts: { noAdmin?: boolean } = {}): Promise<{ ok: true; on: boolean } | { ok: false; error: string }> {
  if (opts.noAdmin) {
    const r = await ownerRead(db.containerName, db.user, 'postgres', OWNER_SSL_READ);
    if (!r.ok) return { ok: false, error: 'refused' in r ? r.refused : r.error };
    const on = parseKeptSsl(r.stdout, 'owner');
    return on === undefined ? { ok: false, error: answered(r.stdout) } : { ok: true, on };
  }
  const r = await dbLogin.runCall(db.containerName, dbLogin.clusterPsql(db.containerName, 'SHOW ssl'));
  if (!r.ok) return { ok: false, error: r.error };
  const on = parseKeptSsl(r.stdout, 'admin');
  return on === undefined ? { ok: false, error: answered(r.stdout) } : { ok: true, on };
}

/** S1's verdict wherever it runs: the refusal, or null when the database may be stopped under Invariant A. */
export function ownerClusterRefusal(user: string, r: Awaited<ReturnType<typeof readOwnerCluster>>): string | null {
  if (!r.ok) return 'refused' in r ? r.refused : KEPT_TEXT.aNaRead(user, r.error);
  const c = r.read;
  if (!c.superuser) return KEPT_TEXT.aNaNotSuper(user);
  if (c.recovery) return KEPT_TEXT.aNaStandby;
  if (c.admin === 'usable') return KEPT_TEXT.aNaAdmin;
  if (c.admin === 'unusable') return KEPT_TEXT.aNaAdminPlain;
  if (c.sessions[0] > 0 && c.sessions[1] > 0) return KEPT_TEXT.aNaSessions(user, c.sessions[0], c.sessions[1]);
  return null;
}

/** A20-NA: S1, then S2 in the bot's database, both as the bot's role; the database already reads running. */
async function ownerGenerationRefusal(db: NonNullable<InstanceConfig['fleetDb']>): Promise<string | null> {
  const s1 = await readOwnerCluster(db.containerName, db.user);
  const bad = ownerClusterRefusal(db.user, s1);
  if (bad) return bad;
  if (!s1.ok || !s1.read.superuser) return KEPT_TEXT.aNaRead(db.user, 'the read answered nothing usable');
  const restore = s1.read.restore;
  if (restore && 'notTable' in restore) return KEPT_TEXT.aGenUnknown(`smdb_manager.restore_state is not a plain table (relkind ${restore.notTable}), so the manager did not read it`);
  if (restore === undefined) return KEPT_TEXT.aGenUnknown(`the restore record answered '${/^restore\|(.*)$/m.exec(s1.stdout)?.[1]?.trim() ?? ''}'`);
  const live = await readOwnerGeneration(db.containerName, db.user, db.db);
  if (!live.ok) return KEPT_TEXT.aGenUnknown('refused' in live ? live.refused : live.error);
  const g = generationBefore(live.row, restore?.floor ?? null);
  return g && g.generation > 1 ? KEPT_TEXT.aGen(g.generation) : null;
}

/** A20: the generation the manager acts on (ownGeneration's rule), read before anything changes; `noAdmin` reads it as the bot's role (A20-NA). */
export async function generationRefusal(db: NonNullable<InstanceConfig['fleetDb']>, opts: { noAdmin?: boolean } = {}): Promise<string | null> {
  const running = await dbLogin.sidecarRunning(db.containerName);
  if (running === null) return KEPT_TEXT.aGenUnknown(`docker did not say whether the database container ${db.containerName} runs`);
  if (!running) return KEPT_TEXT.aGenDown;
  if (opts.noAdmin) return ownerGenerationRefusal(db);
  const t = { container: db.containerName, user: db.user };
  const meta = await fleetSwitch.readGeneration(t, db.db);
  const live = !meta.ok && dbLogin.missingLogin(meta.stderr ?? '') === dbLogin.META_LOGIN ? await fleetSwitch.readGenerationAsAdmin(t, db.db) : meta;
  if (!live.ok) return KEPT_TEXT.aGenUnknown(live.error);
  const restore = await fleetSwitch.readRestoreState(t);
  if (!restore.ok) return KEPT_TEXT.aGenUnknown(restore.error);
  const g = generationBefore(live.row, restore.state?.floor ?? null);
  return g && g.generation > 1 ? KEPT_TEXT.aGen(g.generation) : null;
}

/** A13 to A14: the stored URL names the database's container and carries a password; the refusal, or null. */
function urlRefusal(db: NonNullable<InstanceConfig['fleetDb']>, url: string): string | null {
  if (url === '') return KEPT_TEXT.aUrlEmpty;
  const host = readDatabaseUrl(url).addresses[0]?.host ?? '';
  if (host !== db.containerName.toLowerCase()) {
    const publicHost = db.replication?.publicHost?.replace(/^\[|\]$/g, '').toLowerCase();
    return publicHost && host === publicHost ? KEPT_TEXT.aUrlHost(host, db.containerName) : KEPT_TEXT.aUrlOther(host, db.containerName);
  }
  let password = '';
  try { password = decodeURIComponent(new URL(url).password); } catch { password = ''; }
  return password ? null : KEPT_TEXT.aNoPass;
}

const withoutEnding = (text: string) => (text.endsWith(NOTHING) ? text.slice(0, -NOTHING.length) : text);

/** A9: a delete lane, a cut lane, a migration, a seed or a migration's hold on this bot; null when none. */
function laneRefusal(botId: string, inst: InstanceConfig, opName: string): string | null {
  const deleting = containerManager.deleteLaneRefusal(botId, opName);
  if (deleting) return deleting.error;
  if (inst.lane) return KEPT_TEXT.aLane(inst.lane.op);
  if (inst.migrate) return containerManager.MIGRATE_GATE.db(containerManager.migrateTo(inst.migrate));
  if (inst.fleetDbReplicaSeed) return KEPT_TEXT.aSeed;
  return containerManager.migrationHoldRefusal(botId)?.error ?? null;
}

/** A9 to A18 and A20, then A19; the slot is already claimed when the variant needs it. */
async function admitFresh(botId: string, inst: InstanceConfig, variant: NewStartVariant, url: string, offMessage: string, na: string | null): Promise<NewStartAdmission> {
  const lane = laneRefusal(botId, inst, NEW_START);
  if (lane) return no(409, lane);
  if (inst.fleetDb?.retiringAt) return no(409, containerManager.unfinishedRetireRefusal(inst.fleetDb.retiringAt));
  const word = variant === 'main' ? switchWord(inst) : inst.fleetDbReplica?.takeover ? 'take-over' : null;
  if (word) return no(409, KEPT_TEXT.aSwitch(word));
  if (inst.fleetDb && inst.fleetDbReplica) return no(409, KEPT_TEXT.aBoth);
  const db = inst.fleetDb;
  if (variant === 'main' && db) {
    const stuck = fleetBackup.getFleetFenceStuck(botId);
    if (stuck) return no(409, KEPT_TEXT.aFence(stuck));
    const badUrl = urlRefusal(db, url);
    if (badUrl) return no(409, badUrl);
    const sharers = await sharersRefusal(inst, url);
    if (sharers) return no(409, sharers);
  }
  let dataDir: string;
  try {
    dataDir = await fleetReplica.instanceDataDir(inst);
  } catch (err) {
    return no(409, KEPT_TEXT.aFolder(getDataPath(inst.id), errText(err)));
  }
  if (path.basename(dataDir) !== 'data') return no(409, KEPT_TEXT.aFolder(dataDir, 'its name is not data'));
  let owner: KeptOpRecord['owner'];
  try {
    const st = fs.statSync(dataDir);
    if (!st.isDirectory()) return no(409, KEPT_TEXT.aFolder(dataDir, 'it is not a folder'));
    owner = { uid: st.uid, gid: st.gid, mode: st.mode & 0o7777 };
  } catch (err) {
    return no(409, KEPT_TEXT.aFolder(dataDir, errText(err)));
  }
  const names = newStartNames(inst, dataDir, Date.now());
  for (const dir of [names.outDir, names.inDir]) {
    try {
      fs.lstatSync(dir);
      return no(409, KEPT_TEXT.aNamesFolder(dir));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return no(409, KEPT_TEXT.aFolder(dir, errText(err)));
    }
  }
  let keptSsl = false;
  if (variant === 'main') {
    const state = dockerClient.volumeState(names.newVolume);
    if (state === 'unknown') return no(409, KEPT_TEXT.aDocker(names.newVolume));
    if (state === 'exists' || containerManager.keptVolumeReason(names.newVolume)) return no(409, KEPT_TEXT.aNamesVolume(names.newVolume));
    const gen = await generationRefusal(db!, { noAdmin: na !== null });
    if (gen) return no(409, gen);
    const ssl = await readKeptSsl(db!, { noAdmin: na !== null });
    if (!ssl.ok) return no(409, KEPT_TEXT.aSslUnknown(ssl.error));
    keptSsl = ssl.on;
  }
  const sharers = variant === 'main' ? fleetBackup.databaseSharers(containerManager.getBot(botId) ?? inst, url).filter(b => b.id !== botId).map(b => b.id) : [];
  const record: KeptOpRecord = {
    op: 'new-start', set: names.stamp, stamp: names.stamp, startedAt: names.startedAt,
    parts: variant === 'main' ? ['db', 'folder'] : variant === 'copy' ? ['copy', 'folder'] : ['folder'],
    dataDir, outDir: names.outDir, inDir: names.inDir, owner,
    ...(variant === 'main' ? { newVolume: names.newVolume, keptSsl } : {}),
    offMessage, sharers, step: 'recorded',
    ...(na !== null ? { noAdminOff: na } : {}),
  };
  let opened: string | null;
  try {
    opened = containerManager.createKeptOpIf(botId, record);
  } catch (err) {
    return no(500, KEPT_TEXT.aRecord(errText(err)));
  }
  if (opened) return no(409, opened);
  console.log(`[KeptData] ${inst.displayName}: ${NEW_START} recorded (${variant}, set ${names.stamp})`);
  return { ok: true, record, resumed: false, slot: false };
}

/**
 * Admission of Start on a new database (N0), under the caller's 'new-database' lock: a refusal changes nothing; an
 * open new-start record resumes after A6 to A8. The backup slot is claimed for a database or copy part (`slot`), and
 * released here on a refusal.
 */
export async function admitNewStart(botId: string): Promise<NewStartAdmission> {
  const inst = containerManager.getBot(botId);
  if (!inst) return no(404, 'Bot not found');
  if (containerManager.isShuttingDown()) return no(503, containerManager.SHUTDOWN_REFUSAL);
  const busy = containerManager.isBotBusy(botId);
  if (busy && busy !== NEW_START_OP) return no(409, busyText(busy));
  if (isFleetBackupBusy(botId)) return no(409, SLOT_TEXT);

  const open = inst.keptOp;
  if (open && (open.op !== 'new-start' || open.undo)) return no(409, containerManager.keptOpOpenText(open));
  let variant: NewStartVariant;
  let url = '';
  if (open) {
    variant = open.parts.includes('db') ? 'main' : open.parts.includes('copy') ? 'copy' : 'folder';
  } else {
    const read = storedEnv(inst);
    if ('error' in read) return no(409, read.error);
    const kind = maintenance.maintenanceKind(inst, read.env);
    if (kind === 'json') return no(409, KEPT_TEXT.aJson);
    if (kind === 'none' || !findAppCapabilities(inst.sourceUrl)?.hooks?.stateFile) return no(409, KEPT_TEXT.aNoFile);
    variant = kind === 'database' ? 'main' : kind === 'copy' ? 'copy' : 'folder';
    url = read.url;
  }

  const slot = variant !== 'folder';
  if (slot && !claimFleetBackupBusy(botId)) return containerManager.isShuttingDown() ? no(503, containerManager.SHUTDOWN_REFUSAL) : no(409, SLOT_TEXT);
  let out: NewStartAdmission;
  try {
    out = await admitClaimed(botId, inst, open ?? null, variant, url);
  } catch (err) {
    if (slot) releaseFleetBackupBusy(botId);
    throw err;
  }
  if (!out.ok) {
    if (slot) releaseFleetBackupBusy(botId);
    return out;
  }
  return { ...out, slot };
}

async function admitClaimed(botId: string, inst: InstanceConfig, open: KeptOpRecord | null, variant: NewStartVariant, url: string): Promise<NewStartAdmission> {
  const off = await offAndStopped(botId, inst, false, KEPT_TEXT.aOff, open ? { open } : { database: variant === 'main' });
  if ('runs' in off) {
    if (!open) return no(409, KEPT_TEXT.aRuns);
    return { ok: false, answer: { success: false, status: 409, open: true, error: KEPT_TEXT.nOpen(await appRunsText(inst), newStartDone(open)) } };
  }
  if ('error' in off) return no(off.status, off.error);
  if (open) {
    console.log(`[KeptData] ${inst.displayName}: ${NEW_START} goes on from step ${open.step}`);
    return { ok: true, record: open, resumed: true, slot: false };
  }
  const fresh = containerManager.getBot(botId) ?? inst;
  return admitFresh(botId, fresh, variant, url, maintenance.maintenanceOf(fresh).message, variant === 'main' ? off.na : null);
}

// ─── Start on a new database: the forward run (3.3) ───

const NO_ANSWER = 'docker did not say whether the bot runs';
const reached = (rec: KeptOpRecord, step: KeptStep) => NEW_START_ORDER.indexOf(rec.step) >= NEW_START_ORDER.indexOf(step);

function folderData(dir: string): FolderData {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 'absent';
    throw err;
  }
  return st.isDirectory() && fs.readdirSync(dir).length === 0 ? 'empty' : 'full';
}

const presence = (dir: string): 'absent' | 'present' => (folderData(dir) === 'absent' ? 'absent' : 'present');

function fsyncDir(dir: string): void {
  if (process.platform === 'win32') return;
  const fd = fs.openSync(dir, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

const sha256Of = (file: string) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

/** The regular *.crt files of a db-certs folder; none when it does not exist. */
function certNames(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).filter(e => e.isFile() && e.name.endsWith('.crt')).map(e => e.name).sort();
}

/** N4: the new folder at inDir with the old folder's owner and mode, the join's certificate files, and the state file written last. */
function buildNewFolder(rec: KeptOpRecord, stateFile: string): void {
  const owner = rec.owner;
  if (!owner) throw new Error('the record holds no owner for the new folder');
  if (!fs.existsSync(rec.inDir)) fs.mkdirSync(rec.inDir, { mode: owner.mode });
  fs.chownSync(rec.inDir, owner.uid, owner.gid);
  fs.chmodSync(rec.inDir, owner.mode);
  const from = path.join(rec.dataDir, 'db-certs');
  const certs = certNames(from);
  if (fs.existsSync(from)) {
    const to = path.join(rec.inDir, 'db-certs');
    fs.mkdirSync(to, { recursive: true, mode: 0o755 });
    fs.chownSync(to, owner.uid, owner.gid);
    fs.chmodSync(to, 0o755);
    for (const left of certNames(to)) if (!certs.includes(left)) fs.rmSync(path.join(to, left));
    for (const name of certs) {
      fs.copyFileSync(path.join(from, name), path.join(to, name));
      fs.chownSync(path.join(to, name), owner.uid, owner.gid);
      fs.chmodSync(path.join(to, name), 0o644);
      if (sha256Of(path.join(from, name)) !== sha256Of(path.join(to, name))) throw new Error(`the copy of ${name} does not read back equal`);
    }
    fsyncDir(to);
  }
  const file = path.join(rec.inDir, stateFile);
  const tmp = `${file}.tmp`;
  const fd = fs.openSync(tmp, 'w', 0o644);
  try {
    fs.writeSync(fd, JSON.stringify({ state: 'maintenance', message: rec.offMessage, since: new Date(Date.now()).toISOString() }, null, 2));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
  fs.chownSync(file, owner.uid, owner.gid);
  fs.chmodSync(file, 0o644);
  fsyncDir(rec.inDir);
  fsyncDir(path.dirname(rec.inDir));
}

/** N6 and P5: brings inDir in as dataDir, after removing an empty dataDir a compose up made; the error text, or null. */
function moveIn(rec: Pick<KeptOpRecord, 'dataDir' | 'inDir'>): string | null {
  try {
    if (folderData(rec.dataDir) === 'empty') fs.rmdirSync(rec.dataDir);
    fs.renameSync(rec.inDir, rec.dataDir);
    fsyncDir(path.dirname(rec.dataDir));
    return null;
  } catch (err) {
    return errText(err);
  }
}

/** T-N-OPEN's folder words the disk shows before the 'folder' save: the new folder built (at inDir, or brought in), the data folder set aside. */
function folderDoneOnDisk(rec: KeptOpRecord, stateFile: string): string[] {
  try {
    const aside = presence(rec.outDir) === 'present';
    const made = newFolderState(rec.inDir, stateFile) === 'built' || (aside && newFolderState(rec.dataDir, stateFile) === 'built');
    return [...(made ? ['the new data folder was made'] : []), ...(aside ? ['the data folder was set aside'] : [])];
  } catch {
    return [];
  }
}

/** The names in `dir` this start did not write; every name when they all look like its own. */
function foreignNames(dir: string, stateFile: string): string[] {
  let all: string[];
  try { all = fs.readdirSync(dir).sort(); } catch { return []; }
  const foreign = all.filter(n => n !== stateFile && n !== `${stateFile}.tmp` && n !== 'db-certs');
  return foreign.length ? foreign : all;
}

/** After N6: dataDir holds exactly what N4 wrote, the certificates equal to the kept folder's. */
function holdsNewFolder(rec: KeptOpRecord, stateFile: string): boolean {
  if (newFolderState(rec.dataDir, stateFile) !== 'built') return false;
  if (fs.existsSync(path.join(rec.dataDir, `${stateFile}.tmp`))) return false;
  const kept = path.join(rec.outDir, 'db-certs');
  const now = path.join(rec.dataDir, 'db-certs');
  if (fs.existsSync(now) !== fs.existsSync(kept)) return false;
  const names = certNames(kept);
  if (names.join('\n') !== certNames(now).join('\n')) return false;
  return names.every(n => sha256Of(path.join(kept, n)) === sha256Of(path.join(now, n)));
}

/** N3's swap, from the instance as stored: the data in use becomes the set `rec.set`. */
function newStartSwap(inst: InstanceConfig, rec: KeptOpRecord, variant: NewStartVariant, password: string): containerManager.KeptSwap {
  const add: KeptDataSet = {
    id: rec.set, keptAt: rec.startedAt, by: 'new-start', folder: rec.outDir,
    ...(inst.fleetJoin ? { join: inst.fleetJoin } : {}),
  };
  if (variant === 'main') {
    const db = inst.fleetDb;
    if (!db || !rec.newVolume) throw new Error('the instance no longer holds the database the record names');
    add.db = db;
    if (inst.fleetRestoreError) add.restoreNotice = inst.fleetRestoreError;
    return { add, fleetDb: { containerName: db.containerName, user: db.user, db: db.db, volume: rec.newVolume, password }, fleetRestoreError: null };
  }
  if (variant === 'copy') {
    if (!inst.fleetDbReplica) throw new Error('the instance no longer holds the live copy the record names');
    add.copy = inst.fleetDbReplica;
    return { add, fleetDbReplica: null };
  }
  return { add };
}

/** The forward run from the step after the record's (3.3); every step reads its effect first, so a resume repeats none. */
async function runNewStart(botId: string, a: NewStartAdmitted): Promise<KeptAnswer> {
  let rec = a.record;
  const key = { op: rec.op, set: rec.set, stamp: rec.stamp };
  const variant: NewStartVariant = rec.parts.includes('db') ? 'main' : rec.parts.includes('copy') ? 'copy' : 'folder';
  const first = containerManager.getBot(botId);
  if (!first) return refuse(404, 'Bot not found');
  const label = first.displayName;

  /** Set while the folder loop runs: its folder steps are saved only at 'folder', so an open answer reads them from the disk. */
  let loopStateFile: string | null = null;
  const open = (reason: string, status = 409, gone = false): KeptAnswer => {
    try {
      containerManager.saveKeptOpIf(botId, key, { lastError: reason, folderGone: gone ? true : undefined });
    } catch (err) {
      console.error(`[KeptData] ${label}: the stop of ${NEW_START} could not be recorded: ${errText(err)}`);
    }
    console.warn(`[KeptData] ${label}: ${NEW_START} stopped at step ${rec.step}: ${reason}`);
    const onDisk = loopStateFile && !reached(rec, 'folder') ? folderDoneOnDisk(rec, loopStateFile) : [];
    return { success: false, status, open: true, error: KEPT_TEXT.nOpen(reason, [...newStartDone(rec), ...onDisk], gone ? variant : undefined) };
  };
  const closed = (): KeptAnswer => refuse(409, `${NEW_START} stopped: ${containerManager.KEPT_RECORD_CLOSED}; nothing more was done`);
  const save = (step: KeptStep): KeptAnswer | null => {
    let r: string | null;
    try {
      r = containerManager.saveKeptOpIf(botId, key, { step });
    } catch (err) {
      return open(`the record could not be saved (${errText(err)})`, 500);
    }
    if (r) return closed();
    rec = { ...rec, step };
    return null;
  };

  let begun: string | null;
  try {
    begun = beginRun(botId, key);
  } catch (err) {
    return open(`the record could not be saved (${errText(err)})`, 500);
  }
  if (begun) return closed();
  const { lastError: _e, folderGone: _g, ...cleared } = rec;
  rec = cleared as KeptOpRecord;

  const stateFile = findAppCapabilities(first.sourceUrl)?.hooks?.stateFile;
  if (!stateFile) return open('this app no longer declares the file its maintenance state is saved in');
  const keptAlready = (first.keptSets || []).find(s => s.id === rec.set);
  const storeName = variant === 'main' ? first.fleetDb?.containerName ?? keptAlready?.db?.containerName
    : variant === 'copy' ? first.fleetDbReplica?.containerName ?? keptAlready?.copy?.containerName : undefined;
  if (variant !== 'folder' && !storeName) return open(`the instance no longer holds the ${variant === 'main' ? 'database' : 'live copy'} the record names`);

  /** The stopped read: the app, and the database or copy container, all stopped. */
  const stoppedRead = async (): Promise<string | null> => {
    const app = await containerManager.appContainerRunning(botId);
    if (app === null) return NO_ANSWER;
    if (app) return appRunsText(first);
    if (!storeName) return null;
    const store = await containerManager.containerRunningExact(storeName);
    if (store === null) return NO_ANSWER;
    return store ? KEPT_TEXT.nRuns(storeName) : null;
  };

  /** A refusal of the re-check before N1: nothing was done, so the record closes and the answer is admission's refusal. */
  const closeRefused = (text: string): KeptAnswer => {
    let r: string | null;
    try {
      r = containerManager.closeKeptOp(botId, key, { last: { op: 'new-start', set: rec.set, outcome: 'failed', text } });
    } catch (err) {
      return open(`${withoutEnding(text)}; the record could not be closed (${errText(err)})`, 500);
    }
    if (r) return closed();
    console.warn(`[KeptData] ${label}: ${NEW_START} refused before N1, record closed: ${text}`);
    return refuse(409, text);
  };

  // A13b, A14 and A15 again before N1, as migrate's isolate does: the record now holds the sharers, so none starts after this read
  if (variant === 'main' && !reached(rec, 'db-stopped')) {
    const inst = containerManager.getBot(botId);
    if (!inst?.fleetDb) return open('the instance no longer holds the database the record names');
    const env = storedEnv(inst);
    if ('error' in env) return closeRefused(env.error);
    const badUrl = urlRefusal(inst.fleetDb, env.url);
    if (badUrl) return closeRefused(badUrl);
    const more = fleetBackup.databaseSharers(inst, env.url).map(b => b.id).filter(id => id !== botId && !rec.sharers.includes(id));
    if (more.length) {
      let r: string | null;
      try {
        r = containerManager.saveKeptOpIf(botId, key, { sharers: [...rec.sharers, ...more] });
      } catch (err) {
        return open(`the record could not be saved (${errText(err)})`, 500);
      }
      if (r) return closed();
      rec = { ...rec, sharers: [...rec.sharers, ...more] };
    }
    const sharers = await sharersRefusal(inst, env.url);
    if (sharers) return closeRefused(sharers);
    if (rec.noAdminOff) {
      const running = await dbLogin.sidecarRunning(inst.fleetDb.containerName);
      if (running === null) return open(`docker did not say whether the database container ${inst.fleetDb.containerName} runs`);
      if (running) {
        const bad = ownerClusterRefusal(inst.fleetDb.user, await readOwnerCluster(inst.fleetDb.containerName, inst.fleetDb.user));
        if (bad) return closeRefused(bad);
      }
    }
  }

  // N1, N1c
  if (variant !== 'folder' && !reached(rec, 'db-stopped')) {
    const stop = await containerManager.stopContainerExact(storeName!, 60);
    if (!stop.ok) return open(`${variant === 'main' ? 'the database' : 'the live copy'} did not stop (${stop.error})`);
    dbLogin.forgetManagerRole(storeName!);
    const s = save('db-stopped');
    if (s) return s;
  }

  // N2, N2c
  if (variant !== 'folder' && !reached(rec, 'db-out')) {
    if (variant === 'main') {
      const out = containerManager.takeFleetDbServicesOut(botId);
      if (!out.success) return open(`the deployed compose could not be changed (${out.error})`);
    } else {
      const out = await containerManager.removeFleetDbReplicaService(botId, storeName!);
      if (!out.success) return open(out.error || 'the live copy\'s service could not be removed');
    }
    const s = save('db-out');
    if (s) return s;
  }

  // N3
  if (!reached(rec, 'swapped')) {
    const inst = containerManager.getBot(botId);
    if (!inst) return refuse(404, 'Bot not found');
    if ((inst.keptSets || []).some(s => s.id === rec.set)) {
      const s = save('swapped');
      if (s) return s;
    } else {
      const why = await stoppedRead();
      if (why) return open(why);
      let password = '';
      if (variant === 'main') {
        const env = storedEnv(inst);
        if ('error' in env) return open('the env store could not be read, so the Database URL\'s password is unknown');
        try { password = decodeURIComponent(new URL(env.url).password); } catch { password = ''; }
        if (!password) return open('the Database URL holds no password for the bot\'s login');
      }
      let r: string | null;
      try {
        r = containerManager.swapKeptData(botId, key, stored => newStartSwap(stored, rec, variant, password), 'swapped');
      } catch (err) {
        return open(`the record could not be saved (${errText(err)})`, 500);
      }
      if (r) return closed();
      rec = { ...rec, step: 'swapped' };
    }
  }

  // N4 to N6
  if (!reached(rec, 'folder')) {
    loopStateFile = stateFile;
    let settled = false;
    let movedIn = false;
    for (let i = 0; i < 4 && !settled; i++) {
      let verdict: FolderAnswer;
      try {
        verdict = folderStep('forward', folderData(rec.dataDir), presence(rec.outDir), newFolderState(rec.inDir, stateFile));
      } catch (err) {
        return open(`the data folders could not be read (${errText(err)})`);
      }
      if (verdict === 'done') {
        settled = true;
      } else if (movedIn) {
        break;
      } else if (typeof verdict === 'object') {
        if (verdict.gone) return open(KEPT_TEXT.nGone(rec.dataDir), 409, true);
        if (!verdict.notOurs) return open(verdict.refuse);
        const dir = verdict.notOurs === 'in' ? rec.inDir : rec.dataDir;
        return open(KEPT_TEXT.nNotOurs(dir, foreignNames(dir, stateFile)));
      } else if (verdict === 'build-in') {
        try {
          buildNewFolder(rec, stateFile);
        } catch (err) {
          return open(`the new data folder could not be made (${errText(err)})`);
        }
      } else {
        const why = await stoppedRead();
        if (why) return open(why);
        // N5 and N6 in one synchronous segment: the bot's folder is missing only between the two renames.
        if (verdict === 'move-out') {
          try {
            fs.renameSync(rec.dataDir, rec.outDir);
          } catch (err) {
            return open(`the data folder could not be renamed (${errText(err)})`);
          }
        }
        const moved = moveIn(rec);
        if (moved) return open(`the new data folder could not be renamed (${moved})`);
        movedIn = true;
      }
    }
    if (!settled) return open('the data folders did not reach the end state of this start');
    let ours: boolean;
    try { ours = holdsNewFolder(rec, stateFile); } catch (err) { return open(`the data folders could not be read (${errText(err)})`); }
    if (!ours) return open(KEPT_TEXT.nNotOurs(rec.dataDir, foreignNames(rec.dataDir, stateFile)));
    const s = save('folder');
    if (s) return s;
  }

  // N7 to N9
  if (variant === 'main') {
    const db = containerManager.getBot(botId)?.fleetDb;
    if (!db || db.volume !== rec.newVolume) return open('the instance no longer holds the new database the record names');
    const t = { container: db.containerName, user: db.user };
    if (!reached(rec, 'db-in')) {
      const written = await containerManager.writeFleetDbService(botId, db);
      if (!written.success) return open(`the new database's service could not be written into the deployed compose (${written.error})`);
      const s = save('db-in');
      if (s) return s;
    }
    if (!reached(rec, 'db-up')) {
      const volume = dockerClient.volumeState(db.volume);
      if (volume === 'unknown') return open(`docker did not say whether the volume ${db.volume} exists`);
      dbLogin.forgetManagerRole(db.containerName);
      const up = await containerManager.startFleetDbSidecar(botId);
      if (!up.success) return open(`the new database did not start (${up.error})`);
      const now = containerManager.getBot(botId);
      if (!now) return refuse(404, 'Bot not found');
      const roles = await fleetReplication.provisionManagedRoles(now);
      if (!roles.ok) return open(`its roles could not be set up (${roles.cls === 'in-recovery' ? 'the database is a live copy in recovery' : roles.error})`);
      const sums = await dbLogin.runCall(db.containerName, dbLogin.clusterPsql(db.containerName, 'SHOW data_checksums'));
      if (!sums.ok) return open(`the manager can't confirm the new database has data checksums on (${sums.error})`);
      if (sums.stdout.trim() !== 'on') return open(KEPT_TEXT.nChecksums);
      if (rec.keptSsl === true) {
        const m = dockerClient.containerMounts(db.containerName, '/var/lib/postgresql/data');
        if (!('ok' in m)) return open('gone' in m ? KEPT_TEXT.nMountGone : KEPT_TEXT.nMountUnknown(m.error));
        if (m.mounts.length !== 1 || m.mounts[0] !== `volume ${rec.newVolume}`) return open(KEPT_TEXT.nMount(m.mounts, rec.newVolume ?? ''));
        const tls = await fleetReplication.ensureLocalTls(db.containerName);
        if (tls) {
          const u = tls.undo;
          return open(!u ? (tls.off ? KEPT_TEXT.nTls(tls.why) : KEPT_TEXT.nTlsUnknown(tls.why))
            : u.stage === 'done' ? KEPT_TEXT.nTlsOff(tls.why)
            : u.stage === 'reload' ? KEPT_TEXT.nTlsOff(tls.why, u.why, !!u.timedOut)
            : u.stage === 'aside' ? KEPT_TEXT.nTlsAside(tls.why, u.why, !!u.timedOut)
            : KEPT_TEXT.nTlsStuck(tls.why, u.why));
        }
      }
      const s = save('db-up');
      if (s) return s;
    }
    if (!reached(rec, 'login')) {
      const loginFail = (why: string) => open(`the bot's login on the new database could not be opened (${why})`);
      const role = await dbLogin.ensureManagerDbRole(t);
      if (!role.ok) return loginFail(role.error);
      const opened = await dbLogin.openBotLogin(t);
      if (!opened.ok) return loginFail(opened.error);
      const read = await dbLogin.readBotLogin(t);
      if (!read.ok) return loginFail(read.error);
      if (read.login.inRecovery) return loginFail('the database read back as a live copy in recovery');
      if (read.login.canLogin !== true) return loginFail('the login read back as blocked');
      const s = save('login');
      if (s) return s;
    }
  }

  // N10
  const app = await containerManager.appContainerRunning(botId);
  if (app === null) return open(NO_ANSWER);
  if (app) return open(await appRunsText(first));
  const kept = (containerManager.getBot(botId)?.keptSets || []).find(s => s.id === rec.set);
  const certs = fs.existsSync(path.join(rec.dataDir, 'db-certs'));
  const sharers = rec.sharers.map(id => containerManager.getBot(id)?.displayName ?? id);
  const text = variant === 'main'
    ? KEPT_TEXT.nDoneMain({ old: kept?.db?.volume ?? '', outDir: rec.outDir, newVolume: rec.newVolume ?? '', certs, replication: !!kept?.db?.replication, sharers: sharers.length ? listText(sharers) : null, tls: rec.keptSsl === true })
    : variant === 'copy'
      ? KEPT_TEXT.nDoneCopy({ volume: kept?.copy?.volume ?? '', outDir: rec.outDir, certs })
      : KEPT_TEXT.nDoneFolder({ outDir: rec.outDir, certs });
  let r: string | null;
  try {
    r = containerManager.closeKeptOp(botId, key, {
      last: { op: 'new-start', set: rec.set, outcome: 'done', text },
      maintenance: {
        state: 'running', message: '', orderedAt: new Date(Date.now()).toISOString(), settled: true, hook: 'not-sent',
        login: variant === 'main' ? 'open' : 'not-managed', savedByBot: null, prior: { state: 'off', message: rec.offMessage },
      },
    });
  } catch (err) {
    return open(`the end could not be recorded (${errText(err)}); run it again`, 500);
  }
  if (r) return closed();
  console.log(`[KeptData] ${label}: ${NEW_START} done (set ${rec.set})`);
  return { success: true, text };
}

/** The route of Start on a new database: claims the bot, takes the 'new-database' lock, admits, then runs or resumes. */
export async function startOnNewDatabase(botId: string): Promise<KeptAnswer> {
  if (!containerManager.getBot(botId)) return refuse(404, 'Bot not found');
  if (containerManager.isShuttingDown()) return refuse(503, containerManager.SHUTDOWN_REFUSAL);
  const held = keptRunning.get(botId);
  if (held) return refuse(409, busyText(held));
  const busy = containerManager.isBotBusy(botId);
  if (busy) return refuse(409, busyText(busy));
  if (!claimKeptRunning(botId, NEW_START_OP)) return refuse(409, busyText(keptRunning.get(botId) ?? NEW_START_OP));
  let slot = false;
  try {
    return await containerManager.withExternalBotOp(botId, NEW_START_OP, async () => {
      const a = await admitNewStart(botId);
      if (!a.ok) return a.answer;
      slot = a.slot;
      return runNewStart(botId, a);
    });
  } catch (err) {
    recordUnexpected(botId, NEW_START, err);
    const op = containerManager.isBotBusy(botId);
    if (op && op !== NEW_START_OP) return refuse(409, busyText(op));
    console.error(`[KeptData] ${botId}: ${NEW_START} stopped on an unexpected error: ${errText(err)}`);
    return refuse(500, `${NEW_START} stopped on an unexpected error: ${errText(err)}`);
  } finally {
    if (slot) releaseFleetBackupBusy(botId);
    keptRunKeys.delete(botId);
    keptRunning.delete(botId);
  }
}

// ─── Put back and the reverse (3.4) ───

const PUT_BACK = 'Put back';
const PUT_BACK_ORDER: KeptStep[] = ['recorded', 'db-stopped', 'db-out', 'swapped', 'folder', 'db-in', 'settled'];
const putBackReached = (step: KeptStep, at: KeptStep) => PUT_BACK_ORDER.indexOf(step) >= PUT_BACK_ORDER.indexOf(at);

export const KEPT_TIMING = { copyUpMs: 30_000, pollMs: 1_000, dockerMs: 30_000, sizeMs: 60_000, copyMs: 60 * 60_000, readyMs: 90_000, tarMs: 30 * 60_000 };

type StoreKind = 'db' | 'copy' | null;
const storeKind = (parts: KeptOpRecord['parts']): StoreKind => (parts.includes('db') ? 'db' : parts.includes('copy') ? 'copy' : null);
const partsOf = (set: KeptDataSet): KeptOpRecord['parts'] =>
  [...(set.db ? ['db' as const] : []), ...(set.copy ? ['copy' as const] : []), ...(set.folder ? ['folder' as const] : [])];

/** The date of a kept set from its id (stampOf of its keptAt, an undo's `-new` suffix allowed), as the window shows it. */
export function keptDate(id: string): string {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})/.exec(id);
  return m ? `${m[1]} ${m[2]}:${m[3]} UTC` : id;
}

/** T-P-OPEN's step words for the steps a put-back record, or a reverse, reached. */
export function putBackDone(rec: Pick<KeptOpRecord, 'step' | 'parts' | 'folderMissing'>): string[] {
  const kind = storeKind(rec.parts);
  const words: Array<[KeptStep, string | null]> = [
    ['db-stopped', kind === 'db' ? 'the database in use was stopped' : kind === 'copy' ? 'the live copy in use was stopped' : null],
    ['db-out', kind ? 'its service was taken out of the compose' : null],
    ['swapped', 'the kept data was recorded as in use and the data in use as kept'],
    ['folder', !rec.parts.includes('folder') ? null : rec.folderMissing ? 'the data folder was found missing and left so' : 'the data folders were exchanged'],
    ['db-in', kind === 'db' ? 'the database\'s service was written' : kind === 'copy' ? 'the live copy\'s service was written and it started' : null],
    ['settled', 'the Off order ran'],
  ];
  return words.filter(([at, w]) => w !== null && putBackReached(rec.step, at)).map(([, w]) => w as string);
}

/** The open text of a record as it stands: a forward new-start's, or Put back's (a put-back or any reverse). */
function recordOpenText(rec: KeptOpRecord, reason: string): string {
  return rec.op === 'new-start' && !rec.undo ? KEPT_TEXT.nOpen(reason, newStartDone(rec)) : KEPT_TEXT.pOpen(reason, putBackDone(rec), !!rec.undo);
}

/** The saves of a put-back or reverse run: every save is a compare-and-save on the record's key. */
function putBackSteps(botId: string, label: string, start: KeptOpRecord) {
  const s = {
    rec: start,
    key: { op: start.op, set: start.set, stamp: start.stamp },
    open(reason: string, status = 409): KeptAnswer {
      try {
        containerManager.saveKeptOpIf(botId, s.key, { lastError: reason });
      } catch (err) {
        console.error(`[KeptData] ${label}: the stop of ${PUT_BACK} could not be recorded: ${errText(err)}`);
      }
      console.warn(`[KeptData] ${label}: ${PUT_BACK} stopped at step ${s.rec.step}: ${reason}`);
      return { success: false, status, open: true, error: KEPT_TEXT.pOpen(reason, putBackDone(s.rec), !!s.rec.undo) };
    },
    closed(): KeptAnswer {
      return refuse(409, `${PUT_BACK} stopped: ${containerManager.KEPT_RECORD_CLOSED}; nothing more was done`);
    },
    begin(): KeptAnswer | null {
      let r: string | null;
      try {
        r = beginRun(botId, s.key);
      } catch (err) {
        return s.open(`the record could not be saved (${errText(err)})`, 500);
      }
      if (r) return s.closed();
      const { lastError: _e, folderGone: _g, ...cleared } = s.rec;
      s.rec = cleared as KeptOpRecord;
      return null;
    },
    save(step: KeptStep, extra: Partial<KeptOpRecord> = {}): KeptAnswer | null {
      let r: string | null;
      try {
        r = containerManager.saveKeptOpIf(botId, s.key, { step, ...extra });
      } catch (err) {
        return s.open(`the record could not be saved (${errText(err)})`, 500);
      }
      if (r) return s.closed();
      s.rec = { ...s.rec, step, ...extra };
      return null;
    },
  };
  return s;
}

/** P6 and U-a for a live copy: its service written and started, then read running within KEPT_TIMING.copyUpMs. */
async function copyUp(botId: string, name: string): Promise<string | null> {
  const applied = await containerManager.applyFleetDbReplicaService(botId);
  if (!applied.success) return `the live copy's service could not be written and started (${applied.error})`;
  let running: boolean | null = null;
  const tries = Math.max(1, Math.ceil(KEPT_TIMING.copyUpMs / KEPT_TIMING.pollMs));
  for (let i = 0; i < tries; i++) {
    if (i > 0) await new Promise(r => setTimeout(r, KEPT_TIMING.pollMs));
    running = await containerManager.containerRunningExact(name);
    if (running) break;
  }
  if (running === null) return `the live copy did not start (docker did not say whether ${name} runs)`;
  return running ? null : `the live copy did not start (${name} is not running)`;
}

/** What one status read says of a live copy put back: where it streams from, or why it does not. */
async function copyNote(botId: string): Promise<CopyNote | undefined> {
  const inst = containerManager.getBot(botId);
  const rec = inst?.fleetDbReplica;
  if (!inst || !rec) return undefined;
  const st = await fleetReplica.getFleetReplicaStatus(inst);
  const live = st.live;
  if (live?.running && live.inRecovery === true && live.receiverStatus === 'streaming') return { streams: `${rec.primaryHost}:${rec.primaryPort}` };
  if (!live) {
    const down = fleetReplica.standbyDownText(st);
    if (!st.probeError || !dbLogin.isMissingManagerRole(st.probeError)) return { unknown: down };
    const user = rec.user ?? '';
    const r = await readOwnerCopy(rec.containerName, user);
    if (!r.ok) return { unknown: `${down}; ${'refused' in r ? KEPT_TEXT.cName(user) : KEPT_TEXT.cRead(user, r.error)}` };
    if (!r.read.superuser) return { unknown: `${down}; ${KEPT_TEXT.cNotSuper(user)}` };
    if (!r.read.recovery) return { down: 'it is not in recovery, so it does not follow the main' };
    if (r.read.status === 'streaming') return { streams: `${rec.primaryHost}:${rec.primaryPort}` };
    return { down: `its WAL receiver reads ${r.read.status || 'nothing'}` };
  }
  if (!live.running) return { stopped: fleetReplica.standbyDownText(st) };
  if (live.inRecovery !== true) return { down: 'it is not in recovery, so it does not follow the main' };
  return { down: `its WAL receiver reads ${live.receiverStatus ?? 'nothing'}` };
}

/** P7: the Off order under the 'put-back' lock; its text, and the warning when it did not settle. */
async function settleOff(botId: string, rec: KeptOpRecord): Promise<{ text: string; warning?: string }> {
  const db = storeKind(rec.parts) === 'db' ? containerManager.getBot(botId)?.fleetDb : undefined;
  if (db) dbLogin.forgetManagerRole(db.containerName);
  const r = await maintenance.runOrderInOp(botId, 'off', rec.offMessage, PUT_BACK_OP);
  if ('refused' in r) return { text: KEPT_TEXT.pOrderRefused(r.error), warning: KEPT_TEXT.pOrderRefused(r.error) };
  return r.settled ? { text: r.text } : { text: r.text, warning: r.text };
}

/** The Off order's outcome as the record holds it, for a resume that finds P7 already run. */
function offAsRecorded(botId: string): { text: string; warning?: string } {
  const inst = containerManager.getBot(botId);
  const m = inst ? maintenance.maintenanceOf(inst) : null;
  if (m?.state === 'off' && m.settled) return { text: 'Off is confirmed.' };
  const text = `Off is not confirmed${m?.lastError ? ` (${m.lastError})` : ''}.`;
  return { text, warning: text };
}

type PutBackPlan = { restoreId: string; asideId: string; inDir: string; outDir: string; mode: 'back' | 'undo' };

/** P3's swap, from the instance as stored: the set `restoreId` comes into use, what was in use becomes `asideId`. */
function putBackSwap(inst: InstanceConfig, plan: PutBackPlan, kind: StoreKind, folder: boolean): containerManager.KeptSwap {
  const set = (inst.keptSets || []).find(s => s.id === plan.restoreId);
  if (!set) throw new Error(`the kept data ${plan.restoreId} is no longer recorded`);
  const add: KeptDataSet = {
    id: plan.asideId, keptAt: new Date(Date.now()).toISOString(), by: 'put-back', folder: folder ? plan.outDir : null,
    ...(kind === 'db' && inst.fleetDb ? { db: inst.fleetDb } : {}),
    ...(kind === 'db' && inst.fleetRestoreError ? { restoreNotice: inst.fleetRestoreError } : {}),
    ...(kind === 'copy' && inst.fleetDbReplica ? { copy: inst.fleetDbReplica } : {}),
    ...(inst.fleetJoin ? { join: inst.fleetJoin } : {}),
  };
  const swap: containerManager.KeptSwap = { add, remove: set.id };
  if (kind === 'db') {
    swap.fleetDb = set.db ?? null;
    swap.fleetRestoreError = set.restoreNotice ?? null;
  }
  if (kind === 'copy') swap.fleetDbReplica = set.copy ?? null;
  if (kind) swap.fleetJoin = set.join ?? null;
  return swap;
}

/** P1 to P8 (3.4) from the step after the record's; a reverse (U-b) runs them with its own plan. */
async function runPutBack(botId: string, start: KeptOpRecord, plan: PutBackPlan): Promise<KeptAnswer> {
  const first = containerManager.getBot(botId);
  if (!first) return refuse(404, 'Bot not found');
  const label = first.displayName;
  const s = putBackSteps(botId, label, start);
  const begun = s.begin();
  if (begun) return begun;
  const kind = storeKind(start.parts);
  const folder = start.parts.includes('folder');
  const sets = () => containerManager.getBot(botId)?.keptSets || [];
  const swapDone = () => sets().some(x => x.id === plan.asideId) && !sets().some(x => x.id === plan.restoreId);
  const current = (inst: InstanceConfig | null | undefined) => (kind === 'db' ? inst?.fleetDb : kind === 'copy' ? inst?.fleetDbReplica : undefined);

  /** The stopped read before P4: the app, and every container of the store records this run swaps. */
  const stoppedRead = async (): Promise<string | null> => {
    const app = await containerManager.appContainerRunning(botId);
    if (app === null) return NO_ANSWER;
    if (app) return appRunsText(first);
    const inst = containerManager.getBot(botId);
    const names = new Set<string>();
    const own = current(inst);
    if (own) names.add(own.containerName);
    for (const set of sets().filter(x => x.id === plan.restoreId || x.id === plan.asideId)) {
      const r = kind === 'db' ? set.db : kind === 'copy' ? set.copy : undefined;
      if (r) names.add(r.containerName);
    }
    for (const name of names) {
      const running = await containerManager.containerRunningExact(name);
      if (running === null) return NO_ANSWER;
      if (running) return KEPT_TEXT.nRuns(name);
    }
    return null;
  };

  /** A refusal of the put-back re-check: only the record exists at 'recorded', so it closes and the answer is the refusal. */
  const closePutBackRefused = (text: string): KeptAnswer => {
    let r: string | null;
    try {
      r = containerManager.closeKeptOp(botId, s.key, { last: { op: 'put-back', set: s.rec.set, outcome: 'failed', text } });
    } catch (err) {
      return s.open(`${withoutEnding(text)}; the record could not be closed (${errText(err)})`, 500);
    }
    if (r) return s.closed();
    console.warn(`[KeptData] ${label}: ${PUT_BACK} refused before P1, record closed: ${text}`);
    return refuse(409, text);
  };

  // The re-check before P1 under Invariant A: a stopped database holds no session, and a running one is read as the bot's role
  if (start.op === 'put-back' && !start.undo && s.rec.noAdminOff && s.rec.step === 'recorded') {
    const db = containerManager.getBot(botId)?.fleetDb;
    if (!db) return s.open(`this instance no longer has a managed database, so the manager cannot check it as the bot's role before the database in use is stopped`);
    const running = await dbLogin.sidecarRunning(db.containerName);
    if (running === null) return s.open(`docker did not say whether the database container ${db.containerName} runs`);
    if (running) {
      const bad = ownerClusterRefusal(db.user, await readOwnerCluster(db.containerName, db.user));
      if (bad) return closePutBackRefused(bad);
    }
  }

  // P1
  if (kind && !putBackReached(s.rec.step, 'db-stopped')) {
    const own = current(containerManager.getBot(botId));
    if (own) {
      const stop = await containerManager.stopContainerExact(own.containerName, 60);
      if (!stop.ok) return s.open(`${kind === 'db' ? 'the database' : 'the live copy'} in use did not stop (${stop.error})`);
      dbLogin.forgetManagerRole(own.containerName);
    }
    const r = s.save('db-stopped');
    if (r) return r;
  }

  // P2
  if (kind && !putBackReached(s.rec.step, 'db-out')) {
    if (kind === 'db') {
      const out = containerManager.takeFleetDbServicesOut(botId);
      if (!out.success) return s.open(`the deployed compose could not be changed (${out.error})`);
    } else {
      const name = current(containerManager.getBot(botId))?.containerName ?? sets().find(x => x.id === plan.restoreId)?.copy?.containerName;
      if (name) {
        const out = await containerManager.removeFleetDbReplicaService(botId, name);
        if (!out.success) return s.open(out.error || 'the live copy\'s service could not be removed');
      }
    }
    const r = s.save('db-out');
    if (r) return r;
  }

  // P3
  if (!putBackReached(s.rec.step, 'swapped')) {
    if (swapDone()) {
      const r = s.save('swapped');
      if (r) return r;
    } else {
      if (!sets().some(x => x.id === plan.restoreId)) return s.open(`the kept data ${plan.restoreId} is no longer recorded`);
      let r: string | null;
      try {
        r = containerManager.swapKeptData(botId, s.key, stored => putBackSwap(stored, plan, kind, folder), 'swapped');
      } catch (err) {
        return s.open(`the record could not be saved (${errText(err)})`, 500);
      }
      if (r) return s.closed();
      s.rec = { ...s.rec, step: 'swapped' };
    }
  }

  // P4, P5
  if (!putBackReached(s.rec.step, 'folder')) {
    let missing = false;
    if (folder) {
      const dirs = { dataDir: start.dataDir, inDir: plan.inDir };
      let settled = false;
      for (let i = 0; i < 4 && !settled; i++) {
        let verdict: FolderAnswer;
        try {
          verdict = folderStep(plan.mode, folderData(start.dataDir), presence(plan.outDir), presence(plan.inDir));
        } catch (err) {
          return s.open(`the data folders could not be read (${errText(err)})`);
        }
        if (verdict === 'done' || verdict === 'missing') {
          settled = true;
          missing = verdict === 'missing';
        } else if (typeof verdict === 'object') {
          if (verdict.notOurs !== 'data') return s.open(verdict.refuse);
          let names: string[] = [];
          try { names = fs.readdirSync(start.dataDir).sort().slice(0, 5); } catch { names = []; }
          return s.open(`${verdict.refuse} (${names.join(', ')})`);
        } else {
          const why = await stoppedRead();
          if (why) return s.open(why);
          // The two renames in one synchronous segment, as N5 and N6.
          if (verdict === 'move-out') {
            try {
              fs.renameSync(start.dataDir, plan.outDir);
            } catch (err) {
              return s.open(`the data folder could not be renamed (${errText(err)})`);
            }
          }
          const moved = moveIn(dirs);
          if (moved) return s.open(`the kept data folder could not be renamed (${moved})`);
        }
      }
      if (!settled) return s.open('the data folders did not reach the end state of this put back');
    }
    const r = s.save('folder', missing ? { folderMissing: true } : {});
    if (r) return r;
  }

  // P6
  let note: CopyNote | undefined;
  if (!putBackReached(s.rec.step, 'db-in')) {
    const own = current(containerManager.getBot(botId));
    if (kind === 'db' && own) {
      const written = await containerManager.writeFleetDbService(botId, own as NonNullable<InstanceConfig['fleetDb']>);
      if (!written.success) return s.open(`the database's service could not be written into the deployed compose (${written.error})`);
    }
    if (kind === 'copy' && own) {
      const up = await copyUp(botId, own.containerName);
      if (up) return s.open(up);
      note = await copyNote(botId);
    }
    const r = s.save('db-in');
    if (r) return r;
  }
  if (kind === 'copy' && !note) note = await copyNote(botId);

  // P7
  let off: { text: string; warning?: string };
  if (!putBackReached(s.rec.step, 'settled')) {
    off = await settleOff(botId, s.rec);
    const r = s.save('settled');
    if (r) return r;
  } else {
    off = offAsRecorded(botId);
  }

  // P8
  const app = await containerManager.appContainerRunning(botId);
  if (app === null) return s.open(NO_ANSWER);
  if (app) return s.open(await appRunsText(first));
  const aside = sets().find(x => x.id === plan.asideId);
  const dbGone = aside?.db ? dockerClient.volumeState(aside.db.volume) === 'absent' : false;
  const folderGone = aside?.folder ? !fs.existsSync(aside.folder) : false;
  const pruned = (set: KeptDataSet): KeptDataSet | null => {
    const next: KeptDataSet = { ...set };
    if (dbGone) delete next.db;
    if (folderGone) next.folder = null;
    return next.db || next.copy || next.folder || next.join ? next : null;
  };
  const kept = aside ? pruned(aside) : null;
  const missing = !!(folder && plan.mode === 'undo' && s.rec.folderMissing);
  let appeared = false;
  if (missing) {
    try { appeared = folderData(start.dataDir) !== 'absent'; } catch (err) { return s.open(`the data folders could not be read (${errText(err)})`); }
  }
  const inst = containerManager.getBot(botId);
  const own = current(inst);
  const text = KEPT_TEXT.pDone({
    date: keptDate(plan.restoreId),
    ...(kind === 'db' && own ? { volume: own.volume } : {}),
    ...(kind === 'copy' && own ? { copyVolume: own.volume } : {}),
    ...(missing ? { missing: start.dataDir, appeared } : folder ? { folder: start.dataDir } : {}),
    ...(kept?.db || kept?.copy ? { asideVolume: (kept.db ?? kept.copy)!.volume } : {}),
    ...(kept?.folder ? { asideFolder: kept.folder } : {}),
    ...(note ? { copy: note } : {}),
    orderText: off.text,
  });
  let r: string | null;
  try {
    r = containerManager.closeKeptOp(botId, s.key, {
      last: { op: 'put-back', set: plan.restoreId, outcome: 'done', text },
      sets: all => all.flatMap(x => (x.id !== plan.asideId ? [x] : pruned(x) ?? [])),
    });
  } catch (err) {
    return s.open(`the end could not be recorded (${errText(err)}); run it again`, 500);
  }
  if (r) return s.closed();
  console.log(`[KeptData] ${label}: ${PUT_BACK} done (set ${plan.restoreId} in use, set ${plan.asideId} kept)`);
  return { success: true, text, ...(off.warning ? { warning: off.warning } : {}) };
}

/** U-a: the forward swap was not done, so its services go back for the records as they stand and Off settles again. */
async function undoNothing(botId: string, start: KeptOpRecord): Promise<KeptAnswer> {
  const inst = containerManager.getBot(botId);
  if (!inst) return refuse(404, 'Bot not found');
  const s = putBackSteps(botId, inst.displayName, start);
  const begun = s.begin();
  if (begun) return begun;
  const kind = storeKind(start.parts);
  if (kind === 'db' && inst.fleetDb) {
    const written = await containerManager.writeFleetDbService(botId, inst.fleetDb);
    if (!written.success) return s.open(`the database's service could not be written into the deployed compose (${written.error})`);
  }
  if (kind === 'copy' && inst.fleetDbReplica) {
    const up = await copyUp(botId, inst.fleetDbReplica.containerName);
    if (up) return s.open(up);
  }
  const off = await settleOff(botId, s.rec);
  const text = KEPT_TEXT.uNothing(off.text);
  let r: string | null;
  try {
    r = containerManager.closeKeptOp(botId, s.key, { last: { op: 'put-back', set: start.set, outcome: 'done', text } });
  } catch (err) {
    return s.open(`the end could not be recorded (${errText(err)}); run it again`, 500);
  }
  if (r) return s.closed();
  console.log(`[KeptData] ${inst.displayName}: ${PUT_BACK} before the earlier data was set aside: nothing was swapped`);
  return { success: true, text, ...(off.warning ? { warning: off.warning } : {}) };
}

/** The reverse of an open new-start or put-back record (U): U-a before the forward swap, else U-b. */
function runReverse(botId: string, rec: KeptOpRecord): Promise<KeptAnswer> {
  const sets = containerManager.getBot(botId)?.keptSets || [];
  const forwardSwapped = sets.some(x => x.id === (rec.op === 'new-start' ? rec.set : rec.asideSet));
  if (rec.step === 'recorded' && !forwardSwapped) return undoNothing(botId, rec);
  return runPutBack(botId, rec, rec.op === 'new-start'
    ? { restoreId: rec.set, asideId: `${rec.stamp}-new`, inDir: rec.outDir, outDir: rec.inDir, mode: 'undo' }
    : { restoreId: rec.asideSet ?? '', asideId: rec.set, inDir: rec.outDir, outDir: rec.inDir, mode: 'undo' });
}

/** NA-b: the instance's kind, from the stored env as admission reads it, is 'database'; an unreadable store answers false. */
function mainKind(inst: InstanceConfig): boolean {
  const read = storedEnv(inst);
  return !('error' in read) && maintenance.maintenanceKind(inst, read.env) === 'database';
}

type PutBackAdmission = { ok: true; slot: boolean; run: () => Promise<KeptAnswer> } | { ok: false; answer: KeptAnswer };
const noPut = (status: number, error: string): PutBackAdmission => ({ ok: false, answer: refuse(status, error) });

/**
 * Admission of Put back (P0), under the caller's 'put-back' lock; a refusal changes nothing. An open record of the set:
 * with undo, the reverse goes on; a new-start record, or a put-back record with `reverse`, starts the reverse; a
 * put-back record without it goes on. The backup slot is claimed for a database or copy part.
 */
async function admitPutBack(botId: string, setId: string, reverse: boolean): Promise<PutBackAdmission> {
  const inst = containerManager.getBot(botId);
  if (!inst) return noPut(404, 'Bot not found');
  if (containerManager.isShuttingDown()) return noPut(503, containerManager.SHUTDOWN_REFUSAL);
  const busy = containerManager.isBotBusy(botId);
  if (busy && busy !== PUT_BACK_OP) return noPut(409, busyText(busy));
  if (isFleetBackupBusy(botId)) return noPut(409, SLOT_TEXT);

  const open = inst.keptOp ?? null;
  if (open && (open.op === 'delete' || open.set !== setId)) return noPut(409, containerManager.keptOpOpenText(open));
  const mode = !open ? 'fresh' : open.undo ? 'undo' : open.op === 'new-start' || reverse ? 'reverse' : 'resume';
  const set = open ? undefined : (inst.keptSets || []).find(x => x.id === setId);
  if (!open && !set) return noPut(409, KEPT_TEXT.pNoSet(setId));
  const parts = open ? open.parts : partsOf(set!);
  if (!parts.length) return noPut(409, KEPT_TEXT.pEmpty(setId));

  const slot = storeKind(parts) !== null;
  if (slot && !claimFleetBackupBusy(botId)) return containerManager.isShuttingDown() ? noPut(503, containerManager.SHUTDOWN_REFUSAL) : noPut(409, SLOT_TEXT);
  let out: PutBackAdmission;
  try {
    out = await admitPutBackClaimed(botId, inst, open, set, mode, parts);
  } catch (err) {
    if (slot) releaseFleetBackupBusy(botId);
    throw err;
  }
  if (!out.ok) {
    if (slot) releaseFleetBackupBusy(botId);
    return out;
  }
  return { ...out, slot };
}

async function admitPutBackClaimed(botId: string, inst: InstanceConfig, open: KeptOpRecord | null, set: KeptDataSet | undefined,
  mode: 'fresh' | 'undo' | 'reverse' | 'resume', parts: KeptOpRecord['parts']): Promise<PutBackAdmission> {
  const skipSettled = mode === 'undo' || mode === 'reverse' || (mode === 'resume' && putBackReached(open!.step, 'db-in'));
  const na: NoAdminGate | undefined = skipSettled ? undefined : open ? { open } : { database: mainKind(inst) };
  const off = await offAndStopped(botId, inst, skipSettled, KEPT_TEXT.pOff, na);
  if ('runs' in off) {
    if (!open) return noPut(409, KEPT_TEXT.aRuns);
    return { ok: false, answer: { success: false, status: 409, open: true, error: recordOpenText(open, await appRunsText(inst)) } };
  }
  if ('error' in off) return noPut(off.status, off.error);

  if (open && mode === 'resume') {
    console.log(`[KeptData] ${inst.displayName}: ${PUT_BACK} goes on from step ${open.step}`);
    return { ok: true, slot: false, run: () => runPutBack(botId, open, { restoreId: open.set, asideId: open.asideSet ?? '', inDir: open.inDir, outDir: open.outDir, mode: 'back' }) };
  }
  if (open && mode === 'undo') {
    console.log(`[KeptData] ${inst.displayName}: the reverse of ${keptOpName(open)} goes on from step ${open.step}`);
    return { ok: true, slot: false, run: () => runReverse(botId, open) };
  }
  if (open) {
    const key = { op: open.op, set: open.set, stamp: open.stamp };
    let r: string | null;
    try {
      r = containerManager.saveKeptOpIf(botId, key, { undo: true, step: 'recorded', lastError: undefined });
    } catch (err) {
      return noPut(500, `${PUT_BACK} was not recorded, so nothing was changed: ${errText(err)}`);
    }
    if (r) return noPut(409, `${PUT_BACK} was not recorded: ${r}; nothing was changed`);
    console.log(`[KeptData] ${inst.displayName}: ${PUT_BACK} reverses ${keptOpName(open)} from step ${open.step}`);
    const rec: KeptOpRecord = { ...open, undo: true, step: 'recorded' };
    delete rec.lastError;
    return { ok: true, slot: false, run: () => runReverse(botId, rec) };
  }

  const fresh = containerManager.getBot(botId) ?? inst;
  const lane = laneRefusal(botId, fresh, PUT_BACK);
  if (lane) return noPut(409, lane);
  const kept = set!;
  if ((kept.db && fresh.fleetDbReplica) || (kept.copy && fresh.fleetDb)) return noPut(409, KEPT_TEXT.pCross(kept.db ? 'db' : 'copy'));
  let url = '';
  if (kept.db) {
    const read = storedEnv(fresh);
    if ('error' in read) return noPut(409, read.error);
    url = read.url;
    const host = url ? readDatabaseUrl(url).addresses[0]?.host ?? '' : '';
    if (host !== kept.db.containerName.toLowerCase()) return noPut(409, KEPT_TEXT.pUrl(kept.db.containerName));
  }
  const store = kept.db ?? kept.copy;
  if (store) {
    const state = dockerClient.volumeState(store.volume);
    if (state === 'unknown') return noPut(409, KEPT_TEXT.aDocker(store.volume));
    if (state === 'absent') return noPut(409, KEPT_TEXT.pGoneVolume(store.volume));
  }
  if (kept.db) {
    const sharers = await sharersRefusal(fresh, url);
    if (sharers) return noPut(409, sharers);
  }
  if (off.na !== null) {
    const db = fresh.fleetDb;
    if (!db) return noPut(409, KEPT_TEXT.aUnsettled(maintenance.maintenanceOf(fresh).lastError || 'the order has not finished'));
    const running = await dbLogin.sidecarRunning(db.containerName);
    if (running === null) return noPut(409, KEPT_TEXT.aNaRead(db.user, `docker did not say whether the database container ${db.containerName} runs`));
    if (!running) return noPut(409, KEPT_TEXT.aNaDown);
    const bad = ownerClusterRefusal(db.user, await readOwnerCluster(db.containerName, db.user));
    if (bad) return noPut(409, bad);
  }
  let dataDir: string;
  try {
    dataDir = await fleetReplica.instanceDataDir(fresh);
  } catch (err) {
    return noPut(409, KEPT_TEXT.aFolder(getDataPath(fresh.id), errText(err)));
  }
  if (path.basename(dataDir) !== 'data') return noPut(409, KEPT_TEXT.aFolder(dataDir, 'its name is not data'));
  const at = Date.now();
  const stamp = stampOf(at);
  const outDir = `${dataDir}.kept-${stamp}`;
  if (kept.folder) {
    if (!fs.existsSync(kept.folder)) return noPut(409, KEPT_TEXT.pGoneFolder(kept.folder));
    try {
      fs.lstatSync(outDir);
      return noPut(409, KEPT_TEXT.aNamesFolder(outDir));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return noPut(409, KEPT_TEXT.aFolder(outDir, errText(err)));
    }
  }
  if ((fresh.keptSets || []).some(x => x.id === stamp)) return noPut(409, KEPT_TEXT.pNamesSet(stamp));
  const record: KeptOpRecord = {
    op: 'put-back', set: kept.id, asideSet: stamp, stamp, startedAt: new Date(at).toISOString(), parts,
    dataDir, outDir, inDir: kept.folder ?? '', offMessage: maintenance.maintenanceOf(fresh).message,
    sharers: kept.db ? fleetBackup.databaseSharers(fresh, url).filter(b => b.id !== botId).map(b => b.id) : [],
    step: 'recorded',
    ...(off.na !== null ? { noAdminOff: off.na } : {}),
  };
  let opened: string | null;
  try {
    opened = containerManager.createKeptOpIf(botId, record);
  } catch (err) {
    return noPut(500, `${PUT_BACK} was not recorded, so nothing was changed: ${errText(err)}`);
  }
  if (opened) return noPut(409, opened);
  console.log(`[KeptData] ${fresh.displayName}: ${PUT_BACK} recorded (set ${kept.id}, what is in use becomes ${stamp})`);
  return { ok: true, slot: false, run: () => runPutBack(botId, record, { restoreId: kept.id, asideId: stamp, inDir: record.inDir, outDir, mode: 'back' }) };
}

const keptOpName = (rec: KeptOpRecord) => containerManager.keptOpName(rec.op);

/**
 * The route of Put back: claims the bot, takes the 'put-back' lock, admits, then runs. On an open record of `setId`
 * it goes on or reverses as admitPutBack says; `reverse` marks the Put back button of an open put-back record.
 */
export async function putBack(botId: string, setId: string, opts: { reverse?: boolean } = {}): Promise<KeptAnswer> {
  if (!containerManager.getBot(botId)) return refuse(404, 'Bot not found');
  if (containerManager.isShuttingDown()) return refuse(503, containerManager.SHUTDOWN_REFUSAL);
  const held = keptRunning.get(botId);
  if (held) return refuse(409, busyText(held));
  const busy = containerManager.isBotBusy(botId);
  if (busy) return refuse(409, busyText(busy));
  if (!claimKeptRunning(botId, PUT_BACK_OP)) return refuse(409, busyText(keptRunning.get(botId) ?? PUT_BACK_OP));
  let slot = false;
  try {
    return await containerManager.withExternalBotOp(botId, PUT_BACK_OP, async () => {
      const a = await admitPutBack(botId, setId, opts.reverse === true);
      if (!a.ok) return a.answer;
      slot = a.slot;
      return a.run();
    });
  } catch (err) {
    recordUnexpected(botId, PUT_BACK, err);
    const op = containerManager.isBotBusy(botId);
    if (op && op !== PUT_BACK_OP) return refuse(409, busyText(op));
    console.error(`[KeptData] ${botId}: ${PUT_BACK} stopped on an unexpected error: ${errText(err)}`);
    return refuse(500, `${PUT_BACK} stopped on an unexpected error: ${errText(err)}`);
  } finally {
    if (slot) releaseFleetBackupBusy(botId);
    keptRunKeys.delete(botId);
    keptRunning.delete(botId);
  }
}

// ─── Delete (3.5) ───

const DELETE = 'Delete';
export const DELETE_OP = 'delete';
const ABANDON_OP = 'abandon';
const DELETE_ORDER: KeptStep[] = ['recorded', 'copy-made', 'dumped', 'scratch-gone', 'checked', 'archived', 'archive-checked', 'removing'];
const deleteReached = (step: KeptStep, at: KeptStep) => DELETE_ORDER.indexOf(step) >= DELETE_ORDER.indexOf(at);
const KEPT_IMAGE = 'postgres:16-alpine';
const GIB = 1024 * 1024 * 1024;
const MIB = 1024 * 1024;
const KEPT_FOLDER_RE = /^data\.(kept|new)-/;

/** The folder Delete writes its archives in, beside the bot's dump folder. */
const keptBackupsDir = (botId: string) => path.join(path.dirname(backupDir(botId)), 'kept');

/** The names of Delete's scratch volume and container, its copy helper and its check throwaway. */
export function keptScratchNames(botId: string): { scratch: string; helper: string; check: string } {
  return { scratch: `smdb-keptcopy-${botId}`, helper: `smdb-keptcopy-${botId}-cp`, check: `smdb-keptcheck-${botId}` };
}

/** T-X-OPEN's step words for the steps a Delete record reached. */
export function deleteDone(rec: Pick<KeptOpRecord, 'step' | 'parts'>): string[] {
  const volume = rec.parts.includes('db') || rec.parts.includes('copy');
  const folder = rec.parts.includes('folder');
  const words: Array<[KeptStep, string, boolean]> = [
    ['copy-made', 'the kept database was copied to a scratch volume', volume],
    ['dumped', 'the copy was dumped', volume],
    ['scratch-gone', 'the scratch copy was removed', volume],
    ['checked', 'the dump restored cleanly in a throwaway database', volume],
    ['archived', 'the kept folder was archived', folder],
    ['archive-checked', 'the archive matched the kept folder', folder],
    ['removing', 'the removal began', true],
  ];
  return words.filter(([at, , on]) => on && deleteReached(rec.step, at)).map(([, w]) => w);
}

type ToolOut = { ok: boolean; stdout: string; stderr: string };

function runTool(cmd: 'docker' | 'tar', args: string[], timeout: number): Promise<ToolOut> {
  return new Promise(resolve => {
    try {
      execFile(cmd, args, { maxBuffer: 4 * 1024 * 1024, timeout }, (err, stdout, stderr) => {
        resolve({ ok: !err, stdout: String(stdout ?? ''), stderr: String(stderr || (err?.killed ? `${cmd} did not answer within ${Math.round(timeout / 1000)} s` : err?.message ?? '')) });
      });
    } catch (err) {
      resolve({ ok: false, stdout: '', stderr: `${cmd} could not be run: ${errText(err)}` });
    }
  });
}

const toolLine = (text: string): string => text.trim().split('\n').map(l => l.trim()).filter(Boolean).pop() || 'no reason given';

/** Removes containers and then volumes by exact name; the first failing line, or null. "No such" counts as removed. */
async function removeExact(containers: string[], volumes: string[]): Promise<string | null> {
  const calls = [...containers.map(n => ['rm', '-f', n]), ...volumes.map(n => ['volume', 'rm', n])];
  for (const args of calls) {
    const r = await runTool('docker', args, KEPT_TIMING.dockerMs);
    if (!r.ok && !/no such/i.test(r.stderr)) return toolLine(r.stderr);
  }
  return null;
}

/** The scratch copy: with `helper`, a copy helper left copying goes first. */
const removeScratch = (n: ReturnType<typeof keptScratchNames>, helper: boolean) =>
  removeExact(helper ? [n.helper, n.scratch] : [n.scratch], [n.scratch]);

/** X0 and the guard before X8: the kept volume is not in use, not named elsewhere, and mounted by no container. */
async function keptVolumeGuard(botId: string, inst: InstanceConfig, setId: string, volume: string): Promise<string | null> {
  if (inst.fleetDb?.volume === volume || inst.fleetDbReplica?.volume === volume) return KEPT_TEXT.xCurrent(volume);
  const kept = containerManager.sharedVolumeReason(volume, botId, { exceptSet: setId });
  if (kept) return KEPT_TEXT.xShared(volume, kept);
  const ps = await runTool('docker', ['ps', '-a', '--filter', `volume=${volume}`, '--format', '{{.Names}}'], KEPT_TIMING.dockerMs);
  if (!ps.ok) return KEPT_TEXT.xPsUnknown(volume, toolLine(ps.stderr));
  const names = ps.stdout.split('\n').map(l => l.trim()).filter(Boolean);
  return names.length ? KEPT_TEXT.xInUse(volume, listText(names)) : null;
}

/** X0 and X9: the kept folder is a data.kept-* or data.new-* folder beside the data folder, never the data folder. */
function keptFolderGuard(folder: string, dataDir: string): string | null {
  const beside = path.resolve(path.dirname(folder)) === path.resolve(path.dirname(dataDir));
  if (!beside || !KEPT_FOLDER_RE.test(path.basename(folder)) || path.resolve(folder) === path.resolve(dataDir)) return KEPT_TEXT.xPath(folder);
  return null;
}

type Entry = { kind: 'file' | 'folder' | 'link' | 'other'; size?: number; target?: string };

/** Every path under `root`, relative with '/', without following links. */
function treeEntries(root: string): Map<string, Entry> {
  const out = new Map<string, Entry>();
  const walk = (rel: string) => {
    for (const name of fs.readdirSync(path.join(root, rel)).sort()) {
      const r = rel ? `${rel}/${name}` : name;
      const full = path.join(root, r);
      const st = fs.lstatSync(full);
      if (st.isSymbolicLink()) out.set(r, { kind: 'link', target: fs.readlinkSync(full) });
      else if (st.isDirectory()) { out.set(r, { kind: 'folder' }); walk(r); } else if (st.isFile()) out.set(r, { kind: 'file', size: st.size });
      else out.set(r, { kind: 'other' });
    }
  };
  walk('');
  return out;
}

const KIND_WORDS: Record<Entry['kind'], string> = { file: 'a file', folder: 'a folder', link: 'a link', other: 'another kind of entry' };

/** X6: the first difference between the kept folder and its extracted archive, or null when they match. */
function treeDifference(folder: string, extracted: string): string | null {
  const kept = treeEntries(folder);
  const back = treeEntries(extracted);
  for (const [rel, a] of kept) {
    if (a.kind === 'other') return `${rel} is neither a file, a folder nor a link`;
    const b = back.get(rel);
    if (!b) return `${rel} is missing from the archive`;
    if (a.kind !== b.kind) return `${rel} is ${KIND_WORDS[a.kind]} in the folder and ${KIND_WORDS[b.kind]} in the archive`;
    if (a.kind === 'file') {
      if (a.size !== b.size) return `${rel} differs in size (${a.size} bytes in the folder, ${b.size} in the archive)`;
      if (sha256Of(path.join(folder, rel)) !== sha256Of(path.join(extracted, rel))) return `${rel} differs in content`;
    }
    if (a.kind === 'link' && a.target !== b.target) return `${rel} points to ${a.target} in the folder and to ${b.target} in the archive`;
  }
  for (const rel of back.keys()) if (!kept.has(rel)) return `${rel} is in the archive but not in the folder`;
  return null;
}

function fsyncFile(file: string): void {
  const fd = fs.openSync(file, 'r+');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

/** X1: the kept volume copied through a read-only mount into the scratch volume, after the size read; the failure text, or null. */
async function scratchCopy(botId: string, volume: string, n: ReturnType<typeof keptScratchNames>): Promise<string | null> {
  const left = await removeScratch(n, true);
  if (left) return KEPT_TEXT.xDump(`the scratch copy left by an earlier run could not be removed (${left})`);
  const label = `${THROWAWAY_LABEL}=${botId}`;
  const made = await runTool('docker', ['volume', 'create', '--label', label, n.scratch], KEPT_TIMING.dockerMs);
  if (!made.ok) return KEPT_TEXT.xDump(`the scratch volume could not be made (${toolLine(made.stderr)})`);
  const helper = (script: string) => ['run', '--rm', '--name', n.helper, '--label', label, '--network', 'none',
    '-v', `${volume}:/from:ro`, '-v', `${n.scratch}:/to`, '--entrypoint', 'sh', KEPT_IMAGE, '-c', script];
  const sized = await runTool('docker', helper('du -sk /from && df -Pk /to'), KEPT_TIMING.sizeMs);
  const lines = sized.stdout.trim().split('\n');
  const kb = /^(\d+)\s/.exec(lines[0] ?? '');
  const free = parseDfFreeKb(lines.slice(1).join('\n'));
  if (!sized.ok || !kb || free === null) return KEPT_TEXT.xDump(`the size of the kept database could not be read (${toolLine(sized.ok ? sized.stdout || 'empty output' : sized.stderr)})`);
  const need = Number(kb[1]) * 1024 + GIB;
  if (free * 1024 < need) return KEPT_TEXT.xDisk(Math.floor(free / 1024), Math.ceil(need / MIB));
  const copied = await runTool('docker', helper('cp -a /from/. /to/'), KEPT_TIMING.copyMs);
  if (!copied.ok) return KEPT_TEXT.xDump(`the kept database could not be copied (${toolLine(copied.stderr)})`);
  return null;
}

/** X2: the scratch copy started with no network and dumped; the file, or the failure text. */
async function scratchDump(inst: InstanceConfig, store: { user?: string; db?: string; volume: string }, family: 'main' | 'copy', n: ReturnType<typeof keptScratchNames>): Promise<{ file: string } | { error: string }> {
  if (!store.user || !store.db) return { error: KEPT_TEXT.xDump('the kept record names no database or login to dump') };
  const label = `${THROWAWAY_LABEL}=${inst.id}`;
  const started = await runTool('docker', ['run', '-d', '--name', n.scratch, '--label', label, '--network', 'none',
    '-v', `${n.scratch}:/var/lib/postgresql/data`, KEPT_IMAGE], KEPT_TIMING.sizeMs);
  if (!started.ok) return { error: KEPT_TEXT.xDump(`the scratch copy did not start (${toolLine(started.stderr)})`) };
  const tries = Math.max(1, Math.ceil(KEPT_TIMING.readyMs / KEPT_TIMING.pollMs));
  let ready = false;
  for (let i = 0; i < tries && !ready; i++) {
    if (i > 0) await new Promise(r => setTimeout(r, KEPT_TIMING.pollMs));
    ready = (await runTool('docker', ['exec', n.scratch, 'pg_isready', '-h', '127.0.0.1', '-q'], KEPT_TIMING.dockerMs)).ok;
  }
  if (!ready) return { error: KEPT_TEXT.xDump(`the scratch copy did not accept connections within ${Math.round(KEPT_TIMING.readyMs / 1000)} s`) };
  const dumped = await fleetBackup.dumpKeptDatabase(inst, { containerName: n.scratch, user: store.user, db: store.db }, family, family === 'copy' ? 'copy-pre-delete-' : 'pre-delete-');
  if (dumped.success) return { file: dumped.file };
  return { error: dbLogin.missingLogin(dumped.error) === dbLogin.WORK_LOGIN ? KEPT_TEXT.xDumpFailed(dumped.error) + KEPT_TEXT.xNoWork(store.volume) : KEPT_TEXT.xDump(dumped.error) };
}

/** The saves of a Delete run: every save is a compare-and-save on the record's key. */
function deleteSteps(botId: string, label: string, start: KeptOpRecord, note: string) {
  const s = {
    rec: start,
    key: { op: start.op, set: start.set, stamp: start.stamp },
    /**
     * `whole`: the text is a whole sentence of section 10 and is the answer; otherwise it is T-X-OPEN's reason.
     * `patch` is saved with the stop. The note of a volume X0 dropped ends every open answer.
     */
    open(reason: string, o: { status?: number; whole?: boolean; patch?: Partial<KeptOpRecord> } = {}): KeptAnswer {
      try {
        if (!containerManager.saveKeptOpIf(botId, s.key, { ...o.patch, lastError: reason }) && o.patch) s.rec = { ...s.rec, ...o.patch };
      } catch (err) {
        console.error(`[KeptData] ${label}: the stop of ${DELETE} could not be recorded: ${errText(err)}`);
      }
      console.warn(`[KeptData] ${label}: ${DELETE} stopped at step ${s.rec.step}: ${reason}`);
      const error = o.whole ? reason : KEPT_TEXT.xOpen(reason, deleteDone(s.rec), s.rec.step !== 'removing');
      return { success: false, status: o.status ?? 409, open: true, error: note && !error.endsWith('.') ? `${error}.${note}` : error + note };
    },
    closed(): KeptAnswer {
      return refuse(409, `${DELETE} stopped: ${containerManager.KEPT_RECORD_CLOSED}; nothing more was done`);
    },
    begin(): KeptAnswer | null {
      let r: string | null;
      try {
        r = beginRun(botId, s.key);
      } catch (err) {
        return s.open(`the record could not be saved (${errText(err)})`, { status: 500 });
      }
      if (r) return s.closed();
      const { lastError: _e, folderGone: _g, ...cleared } = s.rec;
      s.rec = cleared as KeptOpRecord;
      return null;
    },
    save(step: KeptStep, extra: Partial<KeptOpRecord> = {}): KeptAnswer | null {
      let r: string | null;
      try {
        r = containerManager.saveKeptOpIf(botId, s.key, { step, ...extra });
      } catch (err) {
        return s.open(`the record could not be saved (${errText(err)})`, { status: 500 });
      }
      if (r) return s.closed();
      s.rec = { ...s.rec, step, ...extra };
      return null;
    },
  };
  return s;
}

/** X1 to X10 from the step after the record's; the backup slot (held for a volume part) is released after X4. */
async function runDelete(botId: string, start: KeptOpRecord, releaseSlot: () => void): Promise<KeptAnswer> {
  const first = containerManager.getBot(botId);
  if (!first) return refuse(404, 'Bot not found');
  const label = first.displayName;
  const set = (first.keptSets || []).find(x => x.id === start.set);
  const note = start.dropped ? KEPT_TEXT.xDropped(start.dropped, start.parts.includes('folder') ? set?.folder ?? null : null) : '';
  const s = deleteSteps(botId, label, start, note);
  const begun = s.begin();
  if (begun) return begun;
  const volumePart = start.parts.includes('db') ? 'db' as const : start.parts.includes('copy') ? 'copy' as const : null;
  if (!set) return s.open(`the kept data ${start.set} is no longer recorded`);
  const store = volumePart === 'db' ? set.db : volumePart === 'copy' ? set.copy : undefined;
  if (volumePart && !store) return s.open(`the kept data ${start.set} no longer names its ${volumePart === 'db' ? 'database' : 'live copy'} volume`);
  const folder = start.parts.includes('folder') ? set.folder : null;
  if (start.parts.includes('folder') && !folder) return s.open(`the kept data ${start.set} no longer names its folder`);
  const n = keptScratchNames(botId);
  const dumpFile = (file: string) => path.join(backupDir(botId), file);
  const dumpHere = () => !!s.rec.dump && fs.existsSync(dumpFile(s.rec.dump)) && fs.existsSync(`${dumpFile(s.rec.dump)}.json`);

  // X1 to X4
  if (store && !deleteReached(s.rec.step, 'checked')) {
    let at = s.rec.step;
    if (at === 'copy-made' || !dumpHere()) at = 'recorded';
    if (at === 'recorded') {
      const copied = await scratchCopy(botId, store.volume, n);
      if (copied) {
        const left = await removeScratch(n, true);
        if (left) console.warn(`[KeptData] ${label}: the scratch copy ${n.scratch} could not be removed (${left}); the next Delete removes it first`);
        return s.open(copied, { whole: true });
      }
      const saved = s.save('copy-made');
      if (saved) return saved;
      const dumped = await scratchDump(first, store, volumePart === 'copy' ? 'copy' : 'main', n);
      if ('error' in dumped) {
        const left = await removeScratch(n, false);
        if (left) console.warn(`[KeptData] ${label}: the scratch copy ${n.scratch} could not be removed (${left}); the next Delete removes it first`);
        return s.open(dumped.error, { whole: true });
      }
      const savedDump = s.save('dumped', { dump: dumped.file });
      if (savedDump) return savedDump;
      at = 'dumped';
    }
    if (at === 'dumped') {
      const left = await removeScratch(n, false);
      if (left) return s.open(`the scratch copy ${n.scratch} could not be removed (${left})`);
      const saved = s.save('scratch-gone');
      if (saved) return saved;
    }
    const file = s.rec.dump!;
    let verdict: Verdict;
    try {
      const meta = validateDumpMeta(JSON.parse(fs.readFileSync(`${dumpFile(file)}.json`, 'utf-8')));
      verdict = meta.ok
        ? await checkDumpInThrowaway(n.check, botId, dumpFile(file), meta.meta.dbBytes, meta.meta.counts)
        : { passed: false, reason: `the counts recorded with the dump could not be read (${meta.error})` };
    } catch (err) {
      verdict = { passed: false, reason: `the check stopped on an error: ${errText(err)}` };
    } finally {
      const left = await removeExact([n.check], [n.check]);
      if (left) console.warn(`[KeptData] ${label}: the check throwaway ${n.check} could not be removed (${left}); the next Delete removes it first`);
    }
    if (!verdict.passed) return s.open(KEPT_TEXT.xCheck(file, verdict.reason), { whole: true });
    const saved = s.save('checked');
    if (saved) return saved;
  }
  releaseSlot();

  // X5, X6
  const keptBackups = keptBackupsDir(botId);
  const archiveName = `${start.set}.tar`;
  const archive = path.join(keptBackups, archiveName);
  if (folder && !deleteReached(s.rec.step, 'archived')) {
    if (s.rec.archive !== archiveName || !fs.existsSync(archive)) {
      const tmp = `${archive}.tmp`;
      try {
        fs.mkdirSync(keptBackups, { recursive: true, mode: 0o700 });
        fs.rmSync(tmp, { force: true });
      } catch (err) {
        return s.open(KEPT_TEXT.xArchive(errText(err)), { whole: true });
      }
      const tar = await runTool('tar', ['-cf', tmp, '-C', path.dirname(folder), path.basename(folder)], KEPT_TIMING.tarMs);
      let failed = tar.ok ? null : toolLine(tar.stderr);
      if (!failed) {
        try {
          fsyncFile(tmp);
          fs.renameSync(tmp, archive);
          fsyncDir(keptBackups);
        } catch (err) {
          failed = errText(err);
        }
      }
      if (failed) {
        try { fs.rmSync(tmp, { force: true }); } catch { /* the next run removes it first */ }
        return s.open(KEPT_TEXT.xArchive(failed), { whole: true });
      }
    }
    const saved = s.save('archived', { archive: archiveName });
    if (saved) return saved;
  }
  if (folder && !deleteReached(s.rec.step, 'archive-checked')) {
    const check = path.join(keptBackups, `${start.set}.check`);
    let difference: string | null;
    try {
      fs.rmSync(check, { recursive: true, force: true });
      fs.mkdirSync(check, { recursive: true, mode: 0o700 });
      const x = await runTool('tar', ['-xf', archive, '-C', check], KEPT_TIMING.tarMs);
      difference = x.ok ? treeDifference(folder, path.join(check, path.basename(folder))) : `the archive could not be extracted (${toolLine(x.stderr)})`;
    } catch (err) {
      difference = `the folders could not be read (${errText(err)})`;
    }
    try { fs.rmSync(check, { recursive: true, force: true }); } catch (err) { console.warn(`[KeptData] ${label}: ${check} could not be removed (${errText(err)})`); }
    if (difference) {
      const rejected = `${archiveName}.rejected-${stampOf(Date.now())}`;
      let file = rejected;
      try {
        fs.renameSync(archive, path.join(keptBackups, rejected));
      } catch (err) {
        file = archiveName;
        console.warn(`[KeptData] ${label}: the rejected archive ${archive} could not be set aside (${errText(err)}); the next run builds over it`);
      }
      return s.open(KEPT_TEXT.xArchCheck(file, difference, keptBackups), { whole: true, patch: { step: store ? 'checked' : 'recorded', archive: undefined } });
    }
    const saved = s.save('archive-checked');
    if (saved) return saved;
  }

  // X7: the guards again, then 'removing'; the dump and archive are written by now
  const stays = KEPT_TEXT.xStays({ ...(s.rec.dump ? { dump: s.rec.dump } : {}), ...(s.rec.archive ? { archive: s.rec.archive } : {}) });
  const inst = containerManager.getBot(botId);
  if (!inst) return refuse(404, 'Bot not found');
  let volumeState: 'exists' | 'absent' | 'unknown' = 'absent';
  if (store) {
    volumeState = dockerClient.volumeState(store.volume);
    if (volumeState === 'unknown') return s.open(KEPT_TEXT.aDocker(store.volume, stays), { whole: true });
    if (volumeState === 'exists') {
      const guard = await keptVolumeGuard(botId, inst, start.set, store.volume);
      if (guard) return s.open(guard, { whole: true });
    }
  }
  if (folder) {
    let dataDir: string;
    try {
      dataDir = await fleetReplica.instanceDataDir(inst);
    } catch (err) {
      return s.open(KEPT_TEXT.aFolder(getDataPath(inst.id), errText(err), stays), { whole: true });
    }
    const now = (inst.keptSets || []).find(x => x.id === start.set);
    const guard = now?.folder !== folder ? KEPT_TEXT.xPath(folder) : keptFolderGuard(folder, dataDir);
    if (guard) return s.open(guard, { whole: true });
  }
  if (s.rec.step !== 'removing') {
    const saved = s.save('removing');
    if (saved) return saved;
  }
  const partial = (what: { volume?: string; folder?: string }, err: string) =>
    s.open(KEPT_TEXT.xPartial({ ...what, err, ...(s.rec.dump ? { dump: s.rec.dump } : {}), ...(s.rec.archive ? { archive: s.rec.archive } : {}) }), { whole: true });

  // X8
  if (store && volumeState === 'exists') {
    console.log(`[KeptData] ${label}: ${DELETE} removes the kept volume ${store.volume}`);
    if (!dockerClient.removeVolume(store.volume)) return partial({ volume: store.volume }, 'docker did not remove it');
    if (dockerClient.volumeState(store.volume) !== 'absent') return partial({ volume: store.volume }, 'docker still lists it');
  }

  // X9
  if (folder) {
    if (folderData(folder) !== 'absent') {
      console.log(`[KeptData] ${label}: ${DELETE} removes the kept folder ${folder}`);
      try {
        fs.rmSync(folder, { recursive: true });
      } catch (err) {
        return partial({ folder }, errText(err));
      }
      if (folderData(folder) !== 'absent') return partial({ folder }, 'it is still there');
    }
  }

  // X10
  const date = keptDate(start.set);
  const text = (store || folder
    ? KEPT_TEXT.xDone({
      date,
      ...(store ? { volume: store.volume, ...(s.rec.dump ? { dump: s.rec.dump } : {}) } : {}),
      ...(folder ? { folder, ...(s.rec.archive ? { archive: s.rec.archive } : {}) } : {}),
    })
    : KEPT_TEXT.xDoneEmpty(date)) + (start.dropped && folder ? KEPT_TEXT.xDroppedDone(start.dropped) : '');
  let r: string | null;
  try {
    r = containerManager.closeKeptOp(botId, s.key, { last: { op: 'delete', set: start.set, outcome: 'done', text }, sets: all => all.filter(x => x.id !== start.set) });
  } catch (err) {
    return s.open(`the end could not be recorded (${errText(err)}); run it again`, { status: 500 });
  }
  if (r) return s.closed();
  console.log(`[KeptData] ${label}: ${DELETE} done (set ${start.set})`);
  return { success: true, text };
}

type DeleteAdmission = { ok: true; record: KeptOpRecord; slot: boolean } | { ok: false; answer: KeptAnswer };
const noDelete = (status: number, error: string): DeleteAdmission => ({ ok: false, answer: refuse(status, error) });

/** Admission of Delete (X0): a refusal changes nothing; an open Delete record of the set resumes. */
async function admitDelete(botId: string, setId: string, again: boolean): Promise<DeleteAdmission> {
  const inst = containerManager.getBot(botId);
  if (!inst) return noDelete(404, 'Bot not found');
  const open = inst.keptOp ?? null;
  if (open && !(open.op === 'delete' && open.set === setId)) return noDelete(409, containerManager.keptOpOpenText(open));
  if (!open && again) return noDelete(409, KEPT_TEXT.xNoRec);
  const set = (inst.keptSets || []).find(x => x.id === setId);
  if (!set && !open) return noDelete(409, KEPT_TEXT.pNoSet(setId));

  const claimSlot = (): boolean => !isFleetBackupBusy(botId) && claimFleetBackupBusy(botId);
  if (open) {
    const slot = storeKind(open.parts) !== null && !deleteReached(open.step, 'checked');
    if (slot && !claimSlot()) return noDelete(409, SLOT_TEXT);
    console.log(`[KeptData] ${inst.displayName}: ${DELETE} goes on from step ${open.step}`);
    return { ok: true, record: open, slot };
  }

  const kept = set!;
  const part = kept.db ? 'db' as const : kept.copy ? 'copy' as const : null;
  const store = kept.db ?? kept.copy;
  let dropped = false;
  if (store) {
    const state = dockerClient.volumeState(store.volume);
    if (state === 'unknown') return noDelete(409, KEPT_TEXT.aDocker(store.volume));
    dropped = state === 'absent';
    if (!dropped) {
      const guard = await keptVolumeGuard(botId, inst, setId, store.volume);
      if (guard) return noDelete(409, guard);
    }
  }
  let dataDir = '';
  if (kept.folder) {
    try {
      dataDir = await fleetReplica.instanceDataDir(inst);
    } catch (err) {
      return noDelete(409, KEPT_TEXT.aFolder(getDataPath(inst.id), errText(err)));
    }
    const guard = keptFolderGuard(kept.folder, dataDir);
    if (guard) return noDelete(409, guard);
  }
  if (dropped && part && !kept.folder) {
    let r: string | null;
    try {
      r = containerManager.dropKeptPart(botId, setId, part);
    } catch (err) {
      return noDelete(500, `${DELETE} was not recorded, so nothing was changed: ${errText(err)}`);
    }
    if (r) return noDelete(409, r);
    console.log(`[KeptData] ${inst.displayName}: the kept volume ${store!.volume} of ${setId} no longer exists; the set named nothing else and was removed`);
    return { ok: false, answer: { success: true, text: KEPT_TEXT.xDroppedSet(store!.volume) } };
  }
  const volume = !!part && !dropped;
  if (volume && !claimSlot()) return noDelete(409, SLOT_TEXT);
  const at = Date.now();
  const record: KeptOpRecord = {
    op: 'delete', set: setId, stamp: stampOf(at), startedAt: new Date(at).toISOString(),
    parts: [...(volume ? [part!] : []), ...(kept.folder ? ['folder' as const] : [])],
    dataDir, outDir: '', inDir: '', offMessage: '', sharers: [], step: 'recorded',
    ...(dropped && store ? { dropped: store.volume } : {}),
  };
  let opened: string | null;
  try {
    opened = containerManager.createKeptOpIf(botId, record, dropped && part ? { set: setId, part } : undefined);
  } catch (err) {
    if (volume) releaseFleetBackupBusy(botId);
    return noDelete(500, `${DELETE} was not recorded, so nothing was changed: ${errText(err)}`);
  }
  if (opened) {
    if (volume) releaseFleetBackupBusy(botId);
    return noDelete(409, opened);
  }
  if (dropped) console.log(`[KeptData] ${inst.displayName}: the kept volume ${store!.volume} of ${setId} no longer exists; dropped from the set`);
  console.log(`[KeptData] ${inst.displayName}: ${DELETE} recorded (set ${setId})`);
  return { ok: true, record, slot: volume };
}

const deleteHeldText = (held: string) => (held === DELETE_OP || held === ABANDON_OP ? KEPT_TEXT.xRunning : busyText(held));

/**
 * The route of Delete: claims the bot (no op lock: a Delete touches nothing in use), admits, then runs or resumes.
 * `again` marks Run again on an open record: with no open Delete of the set it answers T-X-NOREC.
 */
export async function deleteKept(botId: string, setId: string, opts: { again?: boolean } = {}): Promise<KeptAnswer> {
  if (!containerManager.getBot(botId)) return refuse(404, 'Bot not found');
  if (containerManager.isShuttingDown()) return refuse(503, containerManager.SHUTDOWN_REFUSAL);
  const held = keptRunning.get(botId);
  if (held) return refuse(409, deleteHeldText(held));
  if (!claimKeptRunning(botId, DELETE_OP)) return refuse(409, deleteHeldText(keptRunning.get(botId) ?? DELETE_OP));
  let slot = false;
  try {
    const a = await admitDelete(botId, setId, opts.again === true);
    if (!a.ok) return a.answer;
    slot = a.slot;
    return await runDelete(botId, a.record, () => {
      if (slot) releaseFleetBackupBusy(botId);
      slot = false;
    });
  } catch (err) {
    recordUnexpected(botId, DELETE, err);
    console.error(`[KeptData] ${botId}: ${DELETE} stopped on an unexpected error: ${errText(err)}`);
    return refuse(500, `${DELETE} stopped on an unexpected error: ${errText(err)}`);
  } finally {
    if (slot) releaseFleetBackupBusy(botId);
    keptRunKeys.delete(botId);
    keptRunning.delete(botId);
  }
}

/** The archives of `set` that X6 rejected and set aside in the kept backups folder; none when it cannot be read. */
function rejectedArchives(botId: string, set: string): string[] {
  try {
    return fs.readdirSync(keptBackupsDir(botId)).filter(n => n.startsWith(`${set}.tar.rejected-`)).sort();
  } catch {
    return [];
  }
}

/** Keep it (X11): closes an open Delete before 'removing', then removes its scratch copy and check throwaway. */
export async function keepKept(botId: string): Promise<KeptAnswer> {
  if (!containerManager.getBot(botId)) return refuse(404, 'Bot not found');
  const held = keptRunning.get(botId);
  if (held) return refuse(409, deleteHeldText(held));
  if (!claimKeptRunning(botId, ABANDON_OP)) return refuse(409, deleteHeldText(keptRunning.get(botId) ?? ABANDON_OP));
  try {
    const inst = containerManager.getBot(botId);
    const rec = inst?.keptOp;
    if (!inst || !rec || rec.op !== 'delete') return refuse(409, KEPT_TEXT.xNoKeep);
    if (rec.step === 'removing') return refuse(409, KEPT_TEXT.xNoAbandon);
    const rejected = rejectedArchives(botId, rec.set);
    const text = KEPT_TEXT.xKept({ date: keptDate(rec.set), ...(rec.dump ? { dump: rec.dump } : {}), ...(rec.archive ? { archive: rec.archive } : {}), ...(rejected.length ? { rejected } : {}) });
    let r: string | null;
    try {
      r = containerManager.closeKeptDeleteIf(botId, { op: rec.op, set: rec.set, stamp: rec.stamp }, { op: 'abandoned', set: rec.set, outcome: 'done', text });
    } catch (err) {
      return refuse(500, `Keep it was not recorded, so the Delete stays open: ${errText(err)}`);
    }
    if (r === 'removing') return refuse(409, KEPT_TEXT.xNoAbandon);
    if (r) return refuse(409, KEPT_TEXT.xNoKeep);
    console.log(`[KeptData] ${inst.displayName}: ${DELETE} of ${rec.set} stopped with Keep it`);
    const n = keptScratchNames(botId);
    const left = [await removeScratch(n, true), await removeExact([n.check], [n.check])].filter((x): x is string => !!x);
    if (!left.length) return { success: true, text };
    console.warn(`[KeptData] ${inst.displayName}: the scratch copy of Delete could not be removed (${left.join('; ')})`);
    return { success: true, text: `${text} The scratch copy could not be removed (${left.join('; ')}); the next Delete removes it first.` };
  } finally {
    keptRunning.delete(botId);
  }
}

// ─── The folder verdict (3.6) ───

export type FolderData = 'absent' | 'empty' | 'full';
export type NewFolderState = 'absent' | 'partial' | 'built' | 'foreign';
export type FolderMode = 'forward' | 'back' | 'undo';
/** `notOurs` names the folder whose content this run did not write: the caller gives T-N-NOTOURS with its names. `gone`: the data folder is gone before it was set aside. */
export type FolderAnswer = 'build-in' | 'move-out' | 'move-in' | 'clear-empty' | 'done' | 'missing' | { refuse: string; notOurs?: 'data' | 'in'; gone?: true };

const NOT_OURS_IN = { refuse: 'the new data folder holds files this start did not write', notOurs: 'in' as const };
const NOT_OURS_DATA = { refuse: 'the data folder holds files this run did not write', notOurs: 'data' as const };

/**
 * Which folder step comes next: `data` is dataDir, `out` the name the folder in use goes to, `inState` the folder that
 * comes into use (newFolderState for 'forward'; 'absent' or 'present' for 'back' and 'undo'). Pure.
 */
export function folderStep(mode: FolderMode, data: FolderData, out: 'absent' | 'present', inState: NewFolderState | 'present'): FolderAnswer {
  if (mode === 'forward') {
    if (inState === 'present') return { refuse: 'the new data folder was not read' };
    if (data !== 'absent' && out === 'absent') {
      if (inState === 'absent' || inState === 'partial') return 'build-in';
      if (inState === 'built') return 'move-out';
      return NOT_OURS_IN;
    }
    if (data !== 'absent' && out === 'present') {
      if (inState === 'absent') return 'done';
      if (inState === 'built') return data === 'empty' ? 'clear-empty' : NOT_OURS_DATA;
      return NOT_OURS_IN;
    }
    if (inState === 'built') return out === 'present' ? 'move-in' : { refuse: 'the data folder is gone, so nothing was set aside', gone: true };
    return { refuse: out === 'present' ? 'no complete new folder to bring in' : 'no folder to bring in' };
  }
  const present = inState !== 'absent';
  if (data !== 'absent') {
    if (out === 'absent') return present ? 'move-out' : mode === 'undo' ? 'done' : { refuse: 'the kept folder is gone' };
    if (!present) return 'done';
    return data === 'empty' ? 'clear-empty' : NOT_OURS_DATA;
  }
  if (present) return 'move-in';
  // The reverse with nothing moved out and the data folder removed outside: it stays missing, and nothing is made.
  return mode === 'undo' ? 'missing' : { refuse: 'no folder to bring in' };
}

/** What N4 left at `inDir`: 'built' only when the state file says maintenance and everything else is db-certs' *.crt files. */
export function newFolderState(inDir: string, stateFile = 'maintenance.json'): NewFolderState {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(inDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 'absent';
    return 'foreign';
  }
  if (!st.isDirectory()) return 'foreign';
  let built = false;
  for (const entry of fs.readdirSync(inDir, { withFileTypes: true })) {
    if (entry.name === stateFile) {
      if (!entry.isFile()) return 'foreign';
      built = savedMaintenance(path.join(inDir, entry.name));
    } else if (entry.name === `${stateFile}.tmp`) {
      if (!entry.isFile()) return 'foreign';
    } else if (entry.name === 'db-certs') {
      if (!entry.isDirectory()) return 'foreign';
      for (const cert of fs.readdirSync(path.join(inDir, entry.name), { withFileTypes: true })) {
        if (!cert.isFile() || !cert.name.endsWith('.crt')) return 'foreign';
      }
    } else {
      return 'foreign';
    }
  }
  return built ? 'built' : 'partial';
}

function savedMaintenance(file: string): boolean {
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf-8'));
    return !!saved && typeof saved === 'object' && saved.state === 'maintenance';
  } catch {
    return false;
  }
}
