import { Bot, LaneResult, laneName, Outcome, ProvisionBody, ReplicaStatus, ReplicationStatus, SwitchAnswer } from './api';
import { CodeField } from './codes';
import { DbLayout } from './dbtext';
import { editField, Field, field, FieldKey, showField } from './field';
import { wrap } from './install';

/** One row of the Actions list, with what its press sends taken from the read it was built from. */
export type ActionRow =
  | { kind: 'enable'; label: string }
  | { kind: 'bound'; label: string }
  | { kind: 'drop'; label: string; slot: string }
  | { kind: 'disable'; label: string }
  | { kind: 'seed'; label: string; startedAt: number; parked: boolean }
  | { kind: 'retire'; label: string }
  | { kind: 'join'; label: string }
  | { kind: 'add'; label: string }
  | { kind: 'remove'; label: string; slot: string | null }
  | { kind: 'reseed'; label: string }
  | { kind: 'handover'; label: string; slot: string; machine: string }
  | { kind: 'cancel'; label: string; mode: string; phase: string; machine: string; file: string; noAddress?: boolean }
  | { kind: 'runagain'; label: string; machine: string }
  | { kind: 'takeover'; label: string }
  | { kind: 'keep'; label: string; machine: string }
  | { kind: 'rejoin'; label: string; machine: string; recorded: boolean }
  | { kind: 'stale'; label: string; host: string; port: string; running: boolean }
  | { kind: 'receive'; label: string; safetyDump: string | null; takeBack?: string; unfinished?: boolean }
  | { kind: 'newcode'; label: string }
  | { kind: 'stopreceive'; label: string; safetyDump: string }
  | { kind: 'moveout'; label: string }
  | { kind: 'push'; label: string }
  | { kind: 'showcode'; label: string }
  | { kind: 'remove-login'; label: string; login: string }
  | { kind: 'renew-code'; label: string };

/** The screen's newest reads the rows are built from; a read that failed or has not landed offers nothing. */
export interface ActionReads {
  replication?: Outcome<{ replication?: ReplicationStatus }>;
  replica?: Outcome<{ replica?: ReplicaStatus | null }>;
  switch?: Outcome<SwitchAnswer>;
  /** A move code made while its screen was not shown, held in the Session for this bot. */
  moveCodeHeld?: boolean;
}

/** The actions the page offers for the bot's state, in the page's order. */
export function actionRows(layout: DbLayout, reads: ActionReads, bot?: Bot): ActionRow[] {
  // The page shows the move code once, under the Move buttons (:3660); a code held after Esc is shown from here.
  const held: ActionRow[] = reads.moveCodeHeld ? [{ kind: 'showcode', label: 'Show the move code' }] : [];
  if (layout === 'copy') return [...held, ...copyRows(reads, bot), ...copySwitchRows(reads)];
  if (layout !== 'main') return held;
  return [...held, ...mainRows(reads), ...mainSwitchRows(reads, bot)];
}

// renderFleetSwitch (:3577): a switch read that failed shows its line and no button (:3584); the page fills the panel
// only from a read that answered (:3588).
function switchRead(reads: ActionReads): SwitchAnswer | null {
  const r = reads.switch;
  return r && r.ok === true ? r.value : null;
}

// The copy layout's Take over: the switch panel of a bot with no main database (:3596), or a copy promoted outside
// the manager (:3204 to :3206). One row for both: they press the same takeOverFleet.
function copySwitchRows(reads: ActionReads): ActionRow[] {
  const replica = reads.replica && reads.replica.ok === true ? reads.replica.value.replica : null;
  const promoted = !!replica?.record && !!replica.live?.running && replica.live.inRecovery === false;
  return switchRead(reads) || promoted ? [{ kind: 'takeover', label: 'Take over' }] : [];
}

// switchPanelHtml (:3592) for a bot with a main database.
function mainSwitchRows(reads: ActionReads, bot: Bot | undefined): ActionRow[] {
  const view = switchRead(reads);
  const db = bot?.fleetDb;
  if (!view || !db) return [];
  const rows: ActionRow[] = [];
  // One Hand over per copy that streams now (:3606 to :3608).
  for (const c of view.copies || []) {
    if (c.streaming && typeof c.slot === 'string' && c.slot) {
      const machine = c.machine || c.slot;
      rows.push({ kind: 'handover', label: `Hand over to ${machine}`, slot: c.slot, machine });
    }
  }
  // Cancel the hand-over or the move while one is recorded (:3609).
  if (db.handover) {
    rows.push({
      kind: 'cancel', label: db.handover.mode === 'stream' ? 'Cancel the hand-over' : 'Cancel the move', mode: db.handover.mode || '',
      phase: db.handover.phase || '', machine: db.handover.machine || 'another machine', file: db.handover.file || '',
      ...(view.noAddress ? { noAddress: true } : {}),
    });
  }
  if (view.runAgain) rows.push({ kind: 'runagain', label: 'Run the main here again', machine: db.handover?.machine || 'another machine' });
  // Stop receiving while receiving (:3610), with a new move code (plan section 9.5); Receive a main with no move recorded
  // (:3611), naming the kept dump of a push that did not finish (:3653 to :3655).
  if (db.receive) {
    rows.push({ kind: 'stopreceive', label: 'Stop receiving', safetyDump: db.receive.safetyDump || '' });
    rows.push({ kind: 'newcode', label: 'Make a new move code (the code shown before stops working)' });
  } else if (!db.handover || view.noAddress) {
    // Under a hand-over to a copy with no address, finished or not, the switch read serves noAddress, and Receive takes the main back.
    rows.push({
      kind: 'receive', label: 'Receive a main', safetyDump: db.pushBroken ? db.pushBroken.safetyDump || '' : null,
      ...(db.handover ? { takeBack: db.handover.machine || 'another machine', ...(db.handover.phase === 'waiting' ? { unfinished: true } : {}) } : {}),
    });
  }
  // Download for a move and Push the main with no move and no receive recorded (:3612 to :3615).
  if (!db.handover && !db.receive) {
    rows.push({ kind: 'moveout', label: 'Make a backup for a move' });
    rows.push({ kind: 'push', label: 'Push the main' });
  }
  // Keep this machine as the main while two mains are recorded (:3617).
  if (db.mainConflict) rows.push({ kind: 'keep', label: 'Keep this machine as the main', machine: db.mainConflict.machine || 'the other machine' });
  // Rejoin as a copy of a recorded main (:3618 to :3622): with its address on record no code is asked.
  const stoppedHandover = !!db.handover && db.handover.mode === 'stream' && db.handover.phase === 'stopped';
  const recordedRejoin = !!db.replacedBy || !!db.mainConflict || stoppedHandover;
  if (recordedRejoin) {
    const machine = (db.replacedBy || db.mainConflict || db.handover)?.machine || 'the main';
    rows.push({ kind: 'rejoin', label: 'Rejoin as a copy', machine, recorded: !!db.replacedBy || !!db.handover?.host });
  }
  // The stale-primary rejoin with a pasted code (:3623 to :3634): while replication is on and no main is recorded.
  if (db.replication && !recordedRejoin) {
    rows.push({
      kind: 'stale', label: 'Rejoin as a copy (join code)', host: db.replication.publicHost || '',
      port: db.replication.hostPort ? String(db.replication.hostPort) : '', running: bot?.status === 'running',
    });
  }
  return rows;
}

function mainRows(reads: ActionReads): ActionRow[] {
  const rows: ActionRow[] = [];
  const replica = reads.replica;
  // renderSeedBanner (index.html:2711): a seed in flight shows Cancel while cancelable and not yet cancelled (:2729 to
  // :2733); a stopped one shows Dismiss (:2738 to :2741). A failed read shows the retry line and no button (:2721).
  if (replica && replica.ok === true) {
    const r = replica.value.replica || null;
    const p = r?.provisioning;
    const k = r?.parkedSeed;
    if (p) {
      if (!p.cancelRequested && p.cancelable && typeof p.startedAt === 'number') {
        rows.push({ kind: 'seed', label: 'Cancel the seed', startedAt: p.startedAt, parked: false });
      }
    } else if (k && typeof k.startedAt === 'number') {
      rows.push({ kind: 'seed', label: 'Dismiss the stopped seed', startedAt: k.startedAt, parked: true });
    }
  }
  // renderFleetReplication (:2829): a failed read shows the retry line and no control (:2840 to :2843).
  const repl = reads.replication;
  if (!repl || repl.ok !== true) return rows;
  const rep = repl.value.replication || { enabled: false };
  // Replication off: the host, port and bound form with Enable (:2846 to :2858).
  if (!rep.enabled) {
    rows.push({ kind: 'enable', label: 'Enable replication' });
    return rows;
  }
  const live = rep.live;
  // Apply 4096 MB bound while the retention is unbounded (:2902 to :2903).
  if (live && live.slotWalKeep === '-1') rows.push({ kind: 'bound', label: 'Apply the 4096 MB WAL bound' });
  // Drop slot on each fleet slot that is not active (:2884 and :2886); slots come only from a live read.
  for (const s of (live && live.slots) || []) {
    if (s.fleet && !s.active) rows.push({ kind: 'drop', label: `Drop slot ${s.slot}${s.machine ? ` (the copy on ${s.machine})` : ''}`, slot: s.slot });
  }
  // Remove on every machine login but this machine's own (renderFleetReplication's Machine logins list).
  for (const l of (live && live.logins) || []) {
    if (!l.own) rows.push({ kind: 'remove-login', label: `Remove the login ${l.login}${l.machine ? ` (${l.machine})` : ''}`, login: l.login });
  }
  rows.push({ kind: 'renew-code', label: 'New join code' });
  // Disable replication (:2920).
  rows.push({ kind: 'disable', label: 'Disable replication' });
  return rows;
}

// renderFleetReplica (:3125): a failed read shows the retry line and no button (:3132 to :3138).
function copyRows(reads: ActionReads, bot: Bot | undefined): ActionRow[] {
  const rows: ActionRow[] = [];
  const read = reads.replica;
  if (!read || read.ok !== true) return rows;
  const r = read.value.replica || { present: false };
  const parked = r.parkedSeed;
  // A stopped seed: Finish retire while env pins are left, and Dismiss (:3145 to :3147).
  if (parked) {
    if (parked.pinsUnretired && parked.pinsUnretired.length) rows.push({ kind: 'retire', label: 'Finish retire (remove the env pins)' });
    if (typeof parked.startedAt === 'number') rows.push({ kind: 'seed', label: 'Dismiss the stopped seed', startedAt: parked.startedAt, parked: true });
  } else if (r.seedNote && typeof r.seedNoteStartedAt === 'number') {
    // The seed note's Dismiss (:3148 to :3149).
    rows.push({ kind: 'seed', label: 'Dismiss the seed note', startedAt: r.seedNoteStartedAt, parked: true });
  }
  // A seed in flight: Cancel while cancelable and not yet cancelled, and nothing else (:3152 to :3166).
  const p = r.provisioning;
  if (p) {
    if (!p.cancelRequested && p.cancelable && typeof p.startedAt === 'number') rows.push({ kind: 'seed', label: 'Cancel the seed', startedAt: p.startedAt, parked: false });
    return rows;
  }
  // No copy recorded: Join and Add a live copy (:3168 to :3181).
  if (!r.record) {
    rows.push({ kind: 'join', label: 'Join the main with a join code' }, { kind: 'add', label: 'Add a live copy' });
    return rows;
  }
  // A recorded copy: Remove replica, Re-seed now while it is still a copy, Join (:3207 to :3234). Take over is part 4's.
  rows.push({ kind: 'remove', label: 'Remove replica', slot: bot?.fleetDbReplica?.slot ?? null });
  if (r.live && r.live.inRecovery !== false) rows.push({ kind: 'reseed', label: 'Re-seed now' });
  rows.push({ kind: 'join', label: 'Join the main with a join code' });
  return rows;
}

/** showNoAnswer (:1398) with its op name, and the reason the answer was lost. */
export function noAnswerText(op: string, why: string): string {
  return `No answer from the manager (${why}); the ${op} may still be running. Check its state before trying again.`;
}

export interface ReplicationAnswer {
  success?: boolean;
  error?: string;
  certRotated?: boolean;
  plainClientsKept?: number;
  urlKept?: string;
  addressesText?: string;
}

// fleetReplEnableNotes (:2954).
export function enableNotes(res: ReplicationAnswer): string {
  let notes = '';
  if (res.certRotated) notes += ' A new server certificate was installed: every other machine needs the new join code.';
  if (res.plainClientsKept) {
    notes += ` The database keeps admitting connections without TLS from ${res.plainClientsKept} address(es) outside 172.16.0.0/12 that the bot may still use on its old URL, until a start finds none of them connected that way.`;
  }
  if (res.urlKept) notes += ` ${res.urlKept}`;
  return notes + (res.addressesText || '');
}

type Said = { ok: boolean | null; text: string };

// enableFleetReplication (:2968) and fleetReplEnabledText (:2964).
export function enableOutcome(r: Outcome<ReplicationAnswer>): Said {
  if (r.ok === null) return { ok: null, text: noAnswerText('replication change', r.text) };
  if (r.ok === false) return { ok: false, text: r.text || 'Failed to enable replication' };
  const res = r.value;
  if (res.success === true) {
    return { ok: true, text: `Replication enabled. Restart the instance to publish the port${res.urlKept ? '' : ' and apply the new database URL'}.${enableNotes(res)}` };
  }
  return { ok: false, text: res.error || 'Failed to enable replication' };
}

// applyFleetReplBound (:2996), after the settings were read.
export function boundOutcome(r: Outcome<ReplicationAnswer>): Said {
  if (r.ok === null) return { ok: null, text: noAnswerText('WAL bound change', r.text) };
  if (r.ok === false) return { ok: false, text: r.text || 'Failed to apply the bound' };
  const res = r.value;
  if (res.success !== true) return { ok: false, text: res.error || 'Failed to apply the bound' };
  return { ok: true, text: `WAL retention bound applied (4096 MB). It takes effect immediately; wal_log_hints applies on the next restart.${enableNotes(res)}` };
}

/** The settings read before the bound: nothing was sent when it fails. */
export function boundReadFailure(r: { ok: false | null; text: string }): Said {
  return { ok: false, text: `Could not read the replication settings (${r.ok === null ? `no answer: ${r.text}` : r.text || 'unknown error'}), so the bound was not applied; nothing was sent.` };
}

// dropFleetSlot (:3013).
export const dropQuestion = (slot: string) => [
  `Drop replication slot ${slot} on this main?`,
  'The WAL it retains is released. A copy that used it can no longer resume and must be re-seeded to attach again.',
];

export function dropOutcome(slot: string, r: Outcome<{ success?: boolean; error?: string }>): Said {
  if (r.ok === null) return { ok: null, text: noAnswerText('slot drop', r.text) };
  if (r.ok === false) return { ok: false, text: r.text || 'Failed to drop the slot' };
  return r.value.success === true ? { ok: true, text: `Slot ${slot} dropped` } : { ok: false, text: r.value.error || 'Failed to drop the slot' };
}

export interface LoginAnswer {
  success?: boolean;
  error?: string;
  text?: string;
  needsConfirm?: boolean;
}

// removeMachineLogin (index.html): the server's text, whatever the answer.
export function removeLoginOutcome(login: string, r: Outcome<LoginAnswer>): Said {
  if (r.ok === null) return { ok: null, text: noAnswerText('login removal', r.text) };
  if (r.ok === false) return { ok: false, text: r.text || `The login ${login} was not removed` };
  if (r.value.success === true) return { ok: true, text: r.value.text || `Removed the login ${login}` };
  return { ok: false, text: r.value.error || `The login ${login} was not removed` };
}

// renewJoinCode (index.html): RENEW-ASK.
export const RENEW_QUESTION = [
  'Make a new join code?',
  'The current code stops adding machines at once, and its open sessions on this database are ended. This machine\'s own login also gets a new password. Machines that joined already keep their own logins.',
];

export function renewOutcome(r: Outcome<LoginAnswer>): Said {
  if (r.ok === null) return { ok: null, text: noAnswerText('join code renewal', r.text) };
  if (r.ok === false) return { ok: false, text: r.text || 'The join code was not renewed' };
  if (r.value.success === true) return { ok: true, text: r.value.text || 'Made a new join code.' };
  return { ok: false, text: r.value.error || 'The join code was not renewed' };
}

/** RENEW-NOCODE (R47): the renewal stands, and the read of the new code failed. */
export const renewNoCodeText = (done: string, reason: string) => `${done} But the code could not be shown: ${reason}`;

// disableFleetReplication (:3024).
export const DISABLE_QUESTION = [
  'Disable replication?',
  'Refused while a copy streams or a seed copies this database, or while a backup or restore runs. Otherwise the inactive copies\' slots are dropped and the join login and every machine\'s login are closed at once; the published port closes at the next restart, and a database URL that names this database is set back to its private form then.',
];

export function disableOutcome(r: Outcome<ReplicationAnswer>): Said {
  if (r.ok === null) return { ok: null, text: noAnswerText('replication change', r.text) };
  if (r.ok === false) return { ok: false, text: r.text || 'Failed to disable replication' };
  const res = r.value;
  const keptNote = res.plainClientsKept ? ` The database keeps admitting connections without TLS from ${res.plainClientsKept} address(es) outside 172.16.0.0/12 that the bot may still use on its old URL, until a start finds none of them connected that way.` : '';
  const urlNote = res.urlKept ? ` ${res.urlKept}` : '';
  if (res.success === true) return { ok: true, text: `Replication disabled. Restart the instance to apply.${urlNote}${keptNote}${res.addressesText || ''}` };
  return { ok: false, text: res.error || 'Failed to disable replication' };
}

export interface SeedCancelAnswer {
  success?: boolean;
  error?: string;
  dismissed?: boolean;
  needsConfirm?: boolean;
  seed?: { startedAt: number; parked: boolean; committed: boolean };
}

// cancelReplicaSeed (:3410): the end of one round that did not ask.
export function seedCancelOutcome(r: Outcome<SeedCancelAnswer>): Said {
  if (r.ok === null) return { ok: null, text: noAnswerText('seed cancel', r.text) };
  if (r.ok === false) return { ok: false, text: r.text || 'Failed to cancel the seed' };
  if (r.value.success === true) return { ok: true, text: r.value.dismissed ? 'Dismissed' : 'Cancel requested' };
  return { ok: false, text: r.value.error || 'Failed to cancel the seed' };
}

// :3424, when the seed changed at each of the three rounds.
export const SEED_CHANGED_TEXT = 'The seed changed each time it was confirmed, so nothing was cancelled; look again';
export const SEED_ROUNDS = 3;

// The form of renderFleetReplication's off state (:2848 to :2852): host, port and WAL bound.
const ENABLE_FIELDS = [
  { label: 'Public host', tip: 'Public host or IP of THIS machine' },
  { label: 'Port', tip: 'empty for 15432' },
  { label: 'WAL bound MB', tip: 'empty for 4096; how much WAL a detached copy may pin on this disk before its slot is invalidated and it must re-seed' },
];

export type EnableBody = { enabled: true; publicHost: string; hostPort?: number; slotWalKeepMb?: number };

/** The Enable form: three fields, Up/Down or Tab between them; `send` checks them as the page does. */
export class EnableForm {
  fields: Field[] = [field(), field(), field()];
  focus = 0;

  key(input: string, key: FieldKey, forwardDelete = false): 'send' | 'leave' | null {
    if (key.escape) return 'leave';
    if (key.return) return 'send';
    if (key.tab || key.downArrow) {
      this.focus = (this.focus + 1) % this.fields.length;
      return null;
    }
    if (key.upArrow) {
      this.focus = (this.focus + this.fields.length - 1) % this.fields.length;
      return null;
    }
    const next = editField(this.fields[this.focus], input, key, forwardDelete);
    if (next) this.fields[this.focus] = next;
    return null;
  }

  /** The body to send, or the page's refusal (refuseBadNumbers :2384, the host check :2973); nothing is sent then. */
  body(): EnableBody | { refusal: string } {
    const [host, port, keep] = this.fields.map((f) => f.text.trim());
    const bad = [[port, 'port'], [keep, 'WAL bound']].filter(([v]) => v !== '' && !Number.isFinite(Number(v))).map(([, l]) => l);
    if (bad.length) return { refusal: `Not a number: ${bad.join(', ')}. Fix it, then try again. Nothing was sent.` };
    if (!host) return { refusal: 'Enter the public host or IP other machines will dial' };
    return { enabled: true, publicHost: host, ...(port !== '' ? { hostPort: Number(port) } : {}), ...(keep !== '' ? { slotWalKeepMb: Number(keep) } : {}) };
  }

  lines(width: number): { lines: string[]; cursor: { line: number; col: number } } {
    const out: string[] = ['Enable replication', '', ...wrap('A copy of this database on another machine. Without one, this machine dying takes the database with it and no other machine can take over as the main.', width), ''];
    let cursor = { line: 0, col: 0 };
    ENABLE_FIELDS.forEach((f, i) => {
      const label = `${i === this.focus ? '>' : ' '} ${f.label.padEnd(13)}`;
      const shown = showField(this.fields[i], Math.max(width - label.length - 1, 12));
      if (i === this.focus) cursor = { line: out.length, col: label.length + 1 + shown.col };
      out.push(`${label} ${shown.text}`);
      out.push(...wrap(f.tip, width, '                '));
    });
    return { lines: out, cursor };
  }
}

// joinFleetFromPanel and provisionFleetReplica (:3322, :3344): shown while a code is checked.
export const CHECKING_TEXT = 'Checking the join code; the first check on a machine downloads the database image and can take a few minutes.';
// refuseWhileChecking (:3255).
export const CHECKING_REFUSAL = 'The last request on this instance got no answer; its state is still being checked.';
// followLostProvisioning's end (:3271), which names the page's panel.
export const NO_SEED_TEXT = "No seed run shows on this instance after 60 s, so the request most likely did not start one. Check the copy's lines on the Database screen before trying again.";
// joinFleetFromPanel (:3321).
export const NO_CODE_TEXT = "Paste the join code from the main's manager first";
// postProvision (:3280): the questions asked before the last answer is shown as it is.
export const PROVISION_ROUNDS = 3;

export const joinQuestion = (name: string) => [
  `Join ${name} to the main in the pasted join code?`,
  "The manager checks the main the code names and saves the code for this bot, which then uses the main's database addresses. The first check on a machine downloads the database image and can take a few minutes.",
];

export const addQuestion = (name: string, coded: boolean) => [
  `Add a live copy of the main's database for ${name}?`,
  `${coded ? 'The manager joins the main in the pasted join code first. ' : ''}The copy then seeds in the background: it copies the whole database from the main, and its phase shows in the copy's lines here.`,
];

/** postProvision (:3281 to :3288): the question for one round and the body that confirms it; `verb` is 'provision' or 're-seed'. */
export function provisionQuestion(error: string, confirmVolume: string | undefined, body: ProvisionBody, verb = 'provision'): { lines: string[]; yes: string; body: ProvisionBody } {
  const Verb = `${verb.charAt(0).toUpperCase()}${verb.slice(1)}`;
  if (confirmVolume) return { lines: [error, `Clear ${confirmVolume} and ${verb}?`], yes: `Y Clear and ${verb}`, body: { ...body, confirmVolume } };
  return { lines: [error, `${Verb} it here anyway?`], yes: `Y ${Verb}`, body: { ...body, confirm: true } };
}

export type CopyAnswer = { success?: boolean; error?: string; message?: string; joinMessage?: string; warning?: string; needsConfirm?: boolean; confirmVolume?: string };

// joinFleetFromPanel (:3319).
export function joinOutcome(r: Outcome<CopyAnswer>): Said {
  if (r.ok === null) return { ok: null, text: noAnswerText('join', r.text) };
  if (r.ok === false) return { ok: false, text: r.text || 'The join code was not used' };
  if (r.value.success !== true) return { ok: false, text: r.value.error || 'The join code was not used' };
  return { ok: true, text: r.value.message || 'Joined the main' };
}

/** An answer after a join with a code carries the join's message (bots.ts:1987 to :1998); the join happened, so it is said first. */
export function joinedFirst(joinMessage: string | undefined, text: string): string {
  return joinMessage ? `${joinMessage} The copy was not started: ${text}` : text;
}

// provisionFleetReplica (:3335): an answer that did not ask, or asked once more after the last round.
export function provisionOutcome(r: Outcome<CopyAnswer>): Said {
  if (r.ok === null) return { ok: null, text: noAnswerText('provisioning', r.text) };
  if (r.ok === false) return { ok: false, text: r.text || 'Failed to start provisioning' };
  if (r.value.success !== true) return { ok: false, text: joinedFirst(r.value.joinMessage, r.value.error || 'Failed to start provisioning') };
  return { ok: true, text: `Provisioning started${r.value.joinMessage ? `. ${r.value.joinMessage}` : ''}` };
}

// removeFleetReplica (:3387).
export const removeQuestion = (slot: string | null) => [
  'Remove this copy?',
  `The data volume is kept, but the MAIN keeps this copy's replication slot${slot ? ` (${slot})` : ''}, which retains WAL until it is dropped there: the main's Database window lists it with a Drop action once nothing streams on it.`,
];

export function removeOutcome(r: Outcome<CopyAnswer>): Said {
  if (r.ok === null) return { ok: null, text: noAnswerText('copy removal', r.text) };
  if (r.ok === false) return { ok: false, text: r.text || 'Failed to remove the copy' };
  if (r.value.success === true) return { ok: true, text: r.value.warning || 'Copy removed' };
  return { ok: false, text: r.value.error || 'Failed to remove the copy' };
}

// reseedStandbyNow (:3434).
export const RESEED_QUESTION = [
  'Re-seed this copy now?',
  "The manager checks the main in this machine's join code, takes a dump of the copy (kept with the backups), then replaces the copy with a fresh copy of the main. If the check or the dump fails, nothing is deleted.",
];

export function reseedOutcome(r: Outcome<CopyAnswer>): Said {
  if (r.ok === null) return { ok: null, text: noAnswerText('re-seed', r.text) };
  if (r.ok === false) return { ok: false, text: r.text || 'Failed to start the re-seed' };
  if (r.value.success === true) return { ok: true, text: 'Re-seed started' };
  return { ok: false, text: r.value.error || 'Failed to start the re-seed' };
}

// finishPinsRetire (:3237).
export function retireOutcome(r: Outcome<CopyAnswer>): Said {
  if (r.ok === null) return { ok: null, text: noAnswerText('pins retire', r.text) };
  if (r.ok === false) return { ok: false, text: r.text || 'Failed to remove the env pins' };
  if (r.value.success !== true) return { ok: false, text: r.value.error || 'Failed to remove the env pins' };
  return r.value.warning ? { ok: false, text: r.value.warning } : { ok: true, text: 'The env pins are removed' };
}

/** The lanes of part 4 by the page's op names (switchRequest's `what`, :3639 to :3686). */
export type LaneOp = 'hand-over' | 'cancel' | 'take-over' | 'keep' | 'receive' | 'stop' | 'push' | 'move' | 'run-again';

// SWITCH_TIMING (fleetSwitch.ts:31 to :44) plus a Running order's hook wait of 120 s: how long an accepted hand-over or
// take-over is waited for.
export const LANE_LIMIT_MS = 20 * 60_000;

// How long an accepted push is waited for: NM20's timed steps after the push is accepted (fleetMove.ts NM20:670 to :748,
// MOVE_TIMING NM20:33: two pushMs of 30 min, three verifyMs of 10 min, five clientMs of 1 min, about 95 min) plus the
// bot's stop, rounded up.
export const PUSH_LIMIT_MS = 110 * 60_000;

// How long an accepted Run the main here again is waited for: the pre-restore dump (dumpTiming.snapshotTimeoutMs 5 min,
// dumpTimeoutMs 10, conflictBudgetMs 10), the meta write (DUMP_TIMEOUT_MS 10), pg_restore (DUMP_TIMEOUT_MS + 30 s), the
// count (restoreCountTiming 5 min), two table-of-contents reads (tocTiming.backstopMs 90 s each) and two database starts
// (START_DB_READY 30 s each) are about 54.5 min, rounded up for the stops and the lift.
export const RUN_AGAIN_LIMIT_MS = 60 * 60_000;

const capitalized = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);

// switchRequest (:3564), while an accepted lane runs.
export const workingText = (name: string) => `Working on ${name}; the result shows here when it finishes`;

/** switchRequest (:3553 to :3574) and onBotSwitch (:3534): the outcome of a lane's last answer. */
export function laneOutcome(op: LaneOp, r: LaneResult): Said {
  switch (r.kind) {
    case 'no-stream':
    case 'unconfirmed':
      return { ok: r.kind === 'no-stream' ? false : null, text: r.text };
    case 'lost':
      return { ok: null, text: op === 'run-again' ? `No answer from the manager (${r.text}); running the main here again may still be in progress. Check its state before trying again.` : noAnswerText(op, r.text) };
    case 'refused':
    case 'question':
      return { ok: false, text: r.text || `${capitalized(laneName(op))} was refused` };
    case 'done':
      return { ok: true, text: r.text || 'Done' };
    default:
      return { ok: r.ok, text: r.text || (r.ok ? `${capitalized(laneName(op))} finished.` : `${capitalized(laneName(op))} failed; the manager gave no reason.`) };
  }
}

/** What another key on a lane's route question says: the question was not confirmed, so nothing was sent again. */
export const LANE_NOT_CONFIRMED: Record<LaneOp, string> = {
  'hand-over': 'Cancelled: the main was not handed over.',
  // The last cancel question comes after the route started this database and deleted the hand-over row (fleetSwitch.ts
  // NM20:774 to :786).
  cancel: 'Not confirmed: the cancel did not finish; the Move lines show what stands.',
  'take-over': 'Cancelled: this copy was not made the main.',
  keep: 'Cancelled: nothing was changed.',
  receive: 'Cancelled: receiving was not started.',
  stop: 'Cancelled: receiving was not stopped.',
  push: 'Cancelled: nothing was pushed.',
  move: 'Cancelled: no backup was made.',
  'run-again': 'Cancelled: nothing was changed.',
};

// handOverFleet (:3638).
export const handOverQuestion = (machine: string) => [
  `Hand over the main to ${machine}?`,
  `The bot stays in maintenance; this machine's database stops once the copy holds every change, and it rejoins as a copy after ${machine} takes over.`,
];

// takeOverFleet (:3647) and the start checkbox (:3598).
export const takeOverQuestion = (start: boolean) => [
  'Make this copy the main database?',
  'The manager checks the old main first; if it handed over to this copy, nothing is lost.',
  `[${start ? 'x' : ' '}] Start the bot here when done (Space changes it)`,
];

// keepFleetMain (:3679).
export const keepQuestion = (machine: string) => [
  'Make this machine the main?',
  `Its generation is raised above ${machine}'s; ${machine}'s manager blocks its bot's login when it next reads this machine (it checks every 5 minutes while it can reach it).`,
];

// receiveFleet (:3653 to :3655): the variant of a push that did not finish names the dump it keeps.
export const receiveQuestion = (safetyDump: string | null, takeBack?: string, unfinished = false) => takeBack && unfinished
  ? [`Take the main back from ${takeBack}?`, `The hand-over to ${takeBack} did not finish. When ${takeBack}'s copy is not connected, the manager first stops this machine's database and the bot, records the hand-over as finished, then starts the database to wait for a push from ${takeBack}'s manager; a dump of it is kept first. When the copy still follows this database, Receive is refused.`]
  : takeBack
  ? [
    `Take the main back from ${takeBack}?`,
    safetyDump !== null
      ? `This machine's database is started and waits for a push from ${takeBack}'s manager. This database holds a push that did not finish, so no new dump is taken; the dump ${safetyDump}, taken before that push, stays with the backups.`
      : `This machine's database is started and waits for a push from ${takeBack}'s manager; a dump of it is kept first.`,
  ]
  : safetyDump !== null
  ? [
    "Replace this machine's database with one pushed from another machine?",
    `The bot must be Off. This database holds a push that did not finish, so no new dump is taken; the dump ${safetyDump}, taken before that push, stays with the backups.`,
  ]
  : ["Replace this machine's database with one pushed from another machine?", 'The bot must be Off; a dump of this database is kept first.'];

// cancelMove (fleetSwitch.ts NM20:740 to :800): what the cancel does for each kind of move, before the route's own question.
export function cancelQuestion(mode: string, machine: string, file: string, phase = '', noAddress = false): { lines: string[]; yes: string } {
  const after = 'Afterwards choose Running on the State screen to start the bot here.';
  if (mode === 'stream' && noAddress) {
    return {
      lines: [
        `Cancel the hand-over to ${machine}?`,
        `${machine} registered no address, so the manager cannot read whether it took over. It deletes the hand-over in this machine's database, which it starts first when it is stopped, and waits a minute for ${machine}'s copy to receive that. If the copy receives it, this database is the main again, with the bot's login still blocked; then choose Running on the State screen to start the bot here. If it does not, the manager can't confirm what ${machine} did: it refuses the cancel, keeps the hand-over recorded, and stops the database again when it had started it.`,
      ],
      yes: 'Y Cancel the hand-over',
    };
  }
  if (mode === 'stream') {
    return {
      lines: [
        `Cancel the hand-over to ${machine}?`,
        `The manager first checks whether ${machine} took over; if it did, the cancel is refused. Otherwise this machine's database starts again as the main and the hand-over is deleted, with the bot's login still blocked. When the manager cannot confirm what ${machine} did, or ${machine} has not received the cancel within a minute, it asks again and says what follows. ${after}`,
      ],
      yes: 'Y Cancel the hand-over',
    };
  }
  // pushMain records phase done once the push finished (fleetMove.ts NM20:621 to :622); cancelMove then refuses (fleetSwitch.ts NM20:750).
  if (mode === 'push' && phase === 'done') {
    return {
      lines: [
        `Cancel the push to ${machine}?`,
        `The push to ${machine} finished: ${machine} is the main, so the manager refuses the cancel. Rejoin this machine as a copy instead.`,
      ],
      yes: 'Y Cancel the push',
    };
  }
  if (mode === 'push') {
    return {
      lines: [
        `Cancel the push to ${machine}?`,
        `This machine's database stays the main; the push never changed it. The manager asks once more before it cancels. ${after} Then press Stop receiving on ${machine}.`,
      ],
      yes: 'Y Cancel the push',
    };
  }
  return {
    lines: [
      'Cancel the move?',
      `This machine's database stays the main, so cancel only if the backup${file ? ` ${file}` : ''} was not restored on another machine: if it was, two machines would each run the bot as the main. The manager asks once more before it cancels. ${after}`,
    ],
    yes: 'Y Cancel the move',
  };
}

// stopReceiving (fleetMove.ts NM20:377 to :404).
export const stopReceiveQuestion = (name: string, safetyDump: string) => [
  `Stop receiving a main for ${name}?`,
  `The receive login is removed, so the move code no longer works. If a push into this database already finished, this database is the main from then on. If a push replaced it without finishing, the bot cannot run on it until you restore the dump${safetyDump ? ` ${safetyDump}` : ''} taken before receiving, or press Receive again.`,
];

// Plan section 9.5: Receive again while receiving makes a new login without a new dump (fleetMove.ts:201 to :215).
export const newCodeQuestion = (name: string) => [
  `Make a new move code for ${name}?`,
  "The code shown before stops working: its login's password changes. No new dump is taken.",
];

// Plan section 9.4: the page pushes with no dialog; here a paste's line break must not start a push.
export const pushQuestion = (name: string) => [
  `Push ${name}'s main database to the machine that made the move code?`,
  "That machine's database is replaced with this one and checked by counts and checksums; it becomes the main, and this machine then rebuilds itself as its copy. A dump of this database is kept with the backups.",
];

// moveOutFleet (:3674).
export const MOVE_OUT_QUESTION = [
  'Make a backup for a move to a machine without an open port?',
  'The bot stays stopped here until you Cancel the move.',
];

// pushFleet (:3669).
export const NO_MOVE_CODE_TEXT = 'Paste the move code from the receiving machine first';

/** The notice when a move code was made while its screen was not shown; the code itself is never in it. */
export const moveCodeReadyText = (name: string) => `The move code for ${name} is ready: open its Database screen, A, Show the move code`;

/** The outcome after the move code was shown on its own screen. */
export const MOVE_CODE_SHOWN_TEXT = 'The move code opened on its own screen. Once that screen has shown it whole, it is not kept after the screen closes; until then, A, Show the move code opens it again. While this machine receives, Make a new move code gives a new one; the code shown before then stops working.';

// rejoinFleet (:3687): recorded, then with a pasted code.
export const rejoinQuestion = (machine: string, coded: boolean) => [
  `Rebuild this machine's database as a copy of ${machine}${coded ? ' from the pasted join code' : ''}?`,
  `A dump of it is kept with the backups first; it holds every change this machine has that ${machine} lacks.`,
];

// rejoinFleet's prompt (:3690).
export const rejoinPrompt = (machine: string) => `Paste ${machine}'s join code to rebuild this machine's database as its copy. A dump of it is kept with the backups first; it holds every change this machine has that ${machine} lacks.`;

// rejoinFleet (:3693 to :3697).
export function rejoinOutcome(r: Outcome<CopyAnswer>): Said {
  if (r.ok === null) return { ok: null, text: noAnswerText('rejoin', r.text) };
  if (r.ok === false) return { ok: false, text: r.text || 'The rejoin was refused' };
  if (r.value.success !== true) return { ok: false, text: r.value.error || 'The rejoin was refused' };
  return { ok: true, text: 'Rejoining as a copy; the Database screen shows its progress' };
}

// The stale-primary rejoin's tip (:3626) and the line shown instead of the form while the bot runs (:3627).
export const STALE_TIP = "When the bot now runs on another machine's database, this database is a stale fork that must never serve again. Rejoining makes it a copy of the new main: it is dumped once under a write fence (kept with the backups) and then deleted; if the dump fails, nothing is deleted. Anything written here after the other machine became the main survives only in that dump.";
export const STALE_RUNNING = 'Stop the bot to rejoin this machine as a copy: that deletes the database it runs on.';

// reseedStalePrimary (:3367), whole; the page's window is the terminal's screen.
export const STALE_QUESTION = [
  'Rejoin this machine as a copy?',
  "This instance's database is dumped once under a write fence (outside connections refused, read-only, sessions closed) and the dump is kept with the backups, then the database is DELETED and replaced with a fresh copy of the pasted main. Before the delete, the pasted main must report a copy of this database (the same system id) on the same or a later timeline; if it does not, or if the dump fails, nothing is deleted. Whatever this database holds that the pasted main does not is discarded; anything written here after the other machine became the main survives only in that dump.",
  'When it finishes, this database is a copy that follows the pasted main and takes no writes of its own. Start the instance, then open its Database screen: the copy\'s lines show "caught up" or the replay lag.',
];

// reseedStalePrimary (:3371 to :3381): an answer that did not ask, or asked once more after the last round.
export function staleOutcome(r: Outcome<CopyAnswer>): Said {
  if (r.ok === null) return { ok: null, text: noAnswerText('re-seed', r.text) };
  if (r.ok === false) return { ok: false, text: r.text || 'Failed to start re-seeding' };
  if (r.value.success !== true) return { ok: false, text: r.value.error || 'Failed to start re-seeding' };
  return { ok: true, text: 'Rejoining as a copy started' };
}

const TIP_INDENT = ' '.repeat(16);

export type FormKind = 'join' | 'add' | 'rejoin' | 'stale' | 'push';

const FORM_TITLES: Record<FormKind, string> = {
  join: 'Join the main with a join code',
  add: 'Add a live copy',
  rejoin: 'Rejoin as a copy',
  stale: 'Rejoin as a copy (join code)',
  push: 'Push the main',
};

/**
 * The form of Join and Add a live copy (:3170 to :3181), Rejoin as a copy with a code (:3690) and the stale-primary
 * rejoin (:3625 to :3633): the code field, and for Add and the stale rejoin the host and port. Enter never sends: it
 * asks the screen for the Y dialog.
 */
export class JoinForm {
  readonly code: CodeField;
  host: Field;
  port: Field;
  focus = 0;

  /** `machine` names the main for Rejoin; `host` and `port` start the stale rejoin's fields at the replication settings (:3630, :3631). */
  constructor(readonly kind: FormKind, hooks: { onEnter: () => void; onEscape: () => void }, readonly opts: { machine?: string; host?: string; port?: string } = {}) {
    this.code = new CodeField(hooks);
    this.host = field(opts.host ?? '');
    this.port = field(opts.port ?? '');
  }

  private get count(): number {
    return this.kind === 'add' || this.kind === 'stale' ? 3 : 1;
  }

  /** 'enter' asks for the dialog, 'leave' closes the form; the code field's keys reach this only when the frame does not route them. */
  key(input: string, key: FieldKey, forwardDelete = false): 'enter' | 'leave' | null {
    if (this.focus === 0) {
      const out = this.code.key(input, key);
      if (out === 'enter') return 'enter';
      if (out === 'escape') return 'leave';
      if (out === 'taken') return null;
    }
    if (key.escape) return 'leave';
    if (key.return) return 'enter';
    if (key.tab || key.downArrow) {
      this.focus = (this.focus + 1) % this.count;
      return null;
    }
    if (key.upArrow) {
      this.focus = (this.focus + this.count - 1) % this.count;
      return null;
    }
    if (this.focus === 0) return null;
    const next = editField(this.focus === 1 ? this.host : this.port, input, key, forwardDelete);
    if (next && this.focus === 1) this.host = next;
    else if (next) this.port = next;
    return null;
  }

  /** The body the page sends (:3320, :3336 to :3345, :3364 to :3370, :3691), or its refusal; nothing is sent then. */
  body(): ProvisionBody | { refusal: string } {
    const joinCode = this.code.text;
    if (this.kind === 'join' || this.kind === 'rejoin') return joinCode ? { joinCode } : { refusal: NO_CODE_TEXT };
    if (this.kind === 'push') return joinCode ? { joinCode } : { refusal: NO_MOVE_CODE_TEXT };
    const host = this.host.text.trim();
    const port = this.port.text.trim();
    if (port !== '' && !Number.isFinite(Number(port))) return { refusal: 'Not a number: port. Fix it, then try again. Nothing was sent.' };
    if (this.kind === 'stale' && !joinCode) return { refusal: NO_CODE_TEXT };
    return { ...(joinCode ? { joinCode } : {}), ...(host ? { publicHost: host } : {}), ...(host && port !== '' ? { hostPort: Number(port) } : {}) };
  }

  lines(width: number): { lines: string[]; cursor?: { line: number; col: number } } {
    const out: string[] = [FORM_TITLES[this.kind], ''];
    if (this.kind === 'stale') out.push(...wrap(STALE_TIP, width), '');
    let cursor: { line: number; col: number } | undefined;
    const label = (i: number, text: string) => `${i === this.focus ? '>' : ' '} ${text.padEnd(13)}`;
    const [masked, note] = this.code.lines(Math.max(width - 17, 12));
    out.push(`${label(0, this.kind === 'push' ? 'Move code' : 'Join code')} ${masked}`);
    const codeTip = this.kind === 'push' ? 'Paste the move code from the receiving machine (Receive a main in its manager).' : this.kind === 'add'
      ? "Paste the join code from the main's manager, or leave it empty to use the code this bot joined with."
      : this.kind === 'rejoin' ? rejoinPrompt(this.opts.machine || 'the main')
        : "Paste the join code from the main's manager.";
    out.push(...wrap(note || codeTip, width, TIP_INDENT));
    if (this.kind === 'add' || this.kind === 'stale') {
      const fields: Array<[Field, string, string]> = [
        [this.host, 'Host', "This machine's address for other machines (blank if it cannot open a port)"],
        [this.port, 'Port', 'empty for 15432; sent only with a host'],
      ];
      fields.forEach(([f, name, tip], j) => {
        const l = label(j + 1, name);
        const shown = showField(f, Math.max(width - l.length - 1, 12));
        if (j + 1 === this.focus) cursor = { line: out.length, col: l.length + 1 + shown.col };
        out.push(`${l} ${shown.text}`);
        out.push(...wrap(tip, width, TIP_INDENT));
      });
    }
    return { lines: out, cursor };
  }
}
