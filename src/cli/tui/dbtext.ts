import * as path from 'path';
import {
  BackupAlert, BackupConfigAnswer, BackupFamilyStatus, Bot, ConnectionsAnswer, FleetBackupStatus, Held, MemoryAnswer, MigrateView, Outcome, RestoreAnswer,
  RestorePreview, ReplicaAnswer, ReplicationStatus, SeedView,
  SwitchAnswer,
} from './api';

// The text functions of the page's Database window and bot card (src/webui/public/index.html), with the page's words.

/** A line of the Database screen; error marks the page's error-message boxes. */
export interface DbLine {
  text: string;
  error?: boolean;
}

export interface Badge {
  text: string;
  title: string;
  danger: boolean;
}

export type When = (ms: number) => string;

/** YYYY-MM-DD HH:MM and the zone name, in the given zone (the dbm process's own by default). */
export function timeIn(zone?: string): When {
  const timeZone = zone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC';
  const format = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  });
  return (ms: number) => {
    if (!Number.isFinite(ms)) return 'an unknown time';
    const p = Object.fromEntries(format.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
    return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute} ${timeZone}`;
  };
}

const tip = (text: string): DbLine => ({ text });
const err = (text: string): DbLine => ({ text, error: true });

// stateName (:950).
export function stateName(state: string | undefined): string {
  return ({ running: 'Running', maintenance: 'Maintenance', off: 'Off' } as Record<string, string>)[state ?? ''] || 'Running';
}

// maintenanceBadges (:959).
export function maintenanceBadges(bot: Bot, when: When): Badge[] {
  if (bot.activeOp === 'maintenance') return [];
  const m = bot.maintenance;
  const out: Badge[] = [];
  if (m && !m.settled) out.push({ text: `${stateName(m.state)} not confirmed`, title: m.lastError || '', danger: true });
  else if (m && m.state === 'maintenance') {
    out.push({ text: 'Maintenance', title: `In maintenance since ${when(Date.parse(m.orderedAt ?? ''))}. Message: ${m.message || "the bot's default text"}`, danger: false });
  } else if (m && m.state === 'off') {
    out.push({ text: 'Off', title: `Off since ${when(Date.parse(m.orderedAt ?? ''))}. Choose Running in State to start it.`, danger: false });
  }
  if (bot.maintenanceDrift) {
    out.push({ text: bot.maintenanceDrift.startsWith('The state is Off') ? 'Off, but running' : 'Database login blocked', title: bot.maintenanceDrift, danger: true });
  }
  return out;
}

// migrateName (:978).
export function migrateName(to: string | undefined): string {
  return to === 'postgres' ? 'Postgres' : 'JSON files';
}

// migrateBadges (:981).
export function migrateBadges(bot: Bot): Badge[] {
  const rec = bot.migrate;
  if (!rec) return [];
  if (bot.activeOp === 'migrate') {
    const title = `${rec.text || ''} Stop and Delete are refused until the manager finishes the migration or leaves it waiting for you; that lasts as long as the copy runs, plus the retries after it stops answering or is interrupted.`;
    return [{ text: `Migrating to ${migrateName(rec.to)}`, title: title.trim(), danger: false }];
  }
  if (rec.phase === 'waiting') return [{ text: 'Migration waiting', title: rec.text || '', danger: true }];
  return [];
}

// fleetBackupBadges (:2809).
export function fleetBackupBadges(fb: FleetBackupStatus | null | undefined): Badge[] {
  if (!fb) return [];
  const families = [fb.main, fb.copy].filter((f): f is BackupFamilyStatus => !!f);
  const dumps = families.map((f) => f.alerts?.dumps).filter((a): a is BackupAlert => !!a);
  const tests = families.map((f) => f.alerts?.test).filter((a): a is BackupAlert => !!a);
  return [
    ...(dumps.length ? [{ text: 'DB backup failed', title: dumps.map((a) => a.text).join('\n'), danger: false }] : []),
    ...(tests.length ? [{ text: 'DB test restore failed', title: tests.map((a) => a.text).join('\n'), danger: false }] : []),
  ];
}

// switchDate (:3529): UTC, as the page writes it.
export function switchDate(iso: string | undefined): string {
  const t = Date.parse(iso || '');
  return Number.isFinite(t) ? `${new Date(t).toISOString().slice(0, 16).replace('T', ' ')} UTC` : 'an unknown time';
}

// switchBadges (:3504).
export function switchBadges(bot: Bot): Badge[] {
  const db = bot.fleetDb || {};
  const out: Badge[] = [];
  const b = (text: string, title: string, danger: boolean) => out.push({ text, title, danger });
  const h = db.handover;
  if (h) {
    const machine = h.machine || 'another machine';
    if (h.mode === 'stream' && h.phase === 'waiting') b('Hand-over not finished', 'Press Hand over again, or Cancel the hand-over', true);
    else if (h.mode === 'stream') {
      b('Handed over', h.host
        ? `Handed over to ${machine} on ${switchDate(h.at)}. This machine rejoins as its copy once ${machine} is the main; last check: ${h.lastCheck || 'not checked yet'}.`
        : `Handed over to ${machine}, which has no address for other machines, so this machine cannot rejoin it as a copy. Its database stays stopped; decommission it, or move the main back here with Push from ${machine}.`, false);
    } else if (h.phase === 'done') b('Handed over', h.mode === 'push' ? `a push to ${machine}` : 'a backup made for a move', false);
    else b('Hand-over not finished', 'Press Push again, or Cancel the push', true);
  }
  if (db.receive) b('Receiving', `Waiting for a push until ${switchDate(db.receive.expiresAt)}`, false);
  if (db.replacedBy) b(`Replaced by ${db.replacedBy.machine}`, `${db.replacedBy.machine} replaced this database as the main (generation ${db.replacedBy.generation}). Rejoin this machine as a copy.`, true);
  if (db.mainConflict) {
    b('Two mains', db.mainConflict.blockError
      ? `This database and ${db.mainConflict.machine} are both mains with the same generation; the bot's login here could not be blocked (${db.mainConflict.blockError}), so bots may still write to this database. Choose one in the Database window.`
      : `This database and ${db.mainConflict.machine} are both mains with the same generation; the bot's login here is blocked. Choose one in the Database window.`, true);
  }
  if (db.pushBroken) b('Push not finished', `A push replaced this database on or before ${switchDate(db.pushBroken.at)} and did not finish, so the bot cannot run on it. Restore the dump ${db.pushBroken.safetyDump} (taken before receiving) with the bot in Maintenance or Off, or press Receive again so the other machine can push again.`, true);
  if (bot.fleetDbReplica && bot.fleetDbReplica.takeover) b('Take-over not finished', 'Press Take over again', true);
  return out;
}

/** The card's database badges in the page's order (:1682): backup alerts, restore, fence, switch, state, migrate. */
export function databaseBadges(bot: Bot, when: When): Badge[] {
  const fb = bot.fleetBackup;
  return [
    ...fleetBackupBadges(fb),
    ...(fb && fb.restoreError ? [{ text: 'DB restore failed', title: fb.restoreError, danger: true }] : []),
    ...(bot.fenceStuck ? [{ text: 'Database fenced', title: bot.fenceStuck, danger: true }] : []),
    ...switchBadges(bot),
    ...maintenanceBadges(bot, when),
    ...migrateBadges(bot),
  ];
}

// databaseButtonHtml (:2541).
export function hasDatabaseScreen(bot: Bot): boolean {
  const own = bot.fleetBackup || bot.fleetDbReplica || bot.fleetDbReplicaSeed || bot.fleetWorker || bot.hasDbBackups;
  return !!own || !!bot.appHooks;
}

export type DbLayout = 'none' | 'copy' | 'main';

// showFleetBackups (:2551): the three layouts.
export function layoutOf(bot: Bot): DbLayout {
  if (!bot.fleetDb && !bot.fleetDbReplica && !bot.fleetDbReplicaSeed && !bot.fleetWorker && !bot.hasDbBackups) return 'none';
  return bot.fleetDb ? 'main' : 'copy';
}

// The no-database layout's line (:2559).
export function placeText(bot: Bot): string {
  return bot.dataPlace === 'json' ? 'This bot keeps its data in JSON files.'
    : bot.dataPlace === 'outside' ? 'This bot keeps its data in a database this manager does not run.'
      : "Can't confirm where this bot keeps its data: its env store cannot be read.";
}

// formatBackupSize (:2520).
export function formatBackupSize(bytes: number): string {
  if (bytes >= 1048576) return (bytes / 1048576).toFixed(1) + ' MB';
  if (bytes >= 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return bytes + ' B';
}

// seedPurposeText (:2526).
export function seedPurposeText(purpose: string | undefined, auto: boolean | undefined, cause: string | undefined): string {
  if (purpose === 'reseed-standby' && auto) {
    if (cause === 'cleared') return 'Rebuilding the copy (it had been emptied by a Re-seed or rebuild that stopped)';
    return cause === 'slot' ? 'Rebuilding the copy (the main no longer kept its place)' : 'Rebuilding the copy';
  }
  if (purpose === 'reseed-standby') return 'Re-seeding the standby';
  if (purpose === 'reseed-stale-primary') return 'Re-seeding this database as a standby';
  return 'Provisioning the standby';
}

// seedDumpHtml (:2747).
export function seedDumpLines(seed: SeedView | null | undefined): DbLine[] {
  return seed && seed.safetyDump ? [tip(`A safety dump of this database, taken under a write fence, is kept with the backups as ${seed.safetyDump}.`)] : [];
}

// seedWarningHtml (:2824).
export function seedWarningLines(warning: string | null | undefined): DbLine[] {
  return warning ? [err(warning)] : [];
}

const hourText = (hour: number | undefined) => `${String(hour ?? 0).padStart(2, '0')}:00`;

// backupTestHtml (:2756).
export function backupTestLine(f: BackupFamilyStatus, when: When): DbLine {
  const t = f.test;
  if (!t) return tip(`No test restore yet; the first runs after the daily backup at ${hourText(f.hour)}.`);
  const file = t.file ?? '';
  if (t.result === 'running') return tip(`Test restore of ${file} running since ${when(t.startedAt ?? NaN)}.`);
  if (t.result === 'interrupted') return tip(`Test restore of ${file} was cut short by a manager restart; it runs again within a minute.`);
  if (t.result === 'passed') return tip(`Test restore of ${file} passed at ${when(t.finishedAt ?? NaN)}: ${t.tables} tables and ${t.rows} rows matched the counts recorded when it was taken${t.text || ''}.`);
  return err(`Test restore of ${file} failed at ${when(t.finishedAt ?? NaN)}: ${t.text || ''}.`);
}

// backupAlertHtml (:2767).
export function backupAlertLines(a: BackupAlert | null | undefined, when: When): DbLine[] {
  if (!a) return [];
  const at = when(a.dmAt ?? NaN);
  const sent = a.dmRepeat ? `At ${at} the bot answered that it had already posted this message, so it posted nothing new.`
    : a.dmPlace === 'channel' ? `The owner was sent a message in the owner messages channel at ${at}.`
      : a.dmPlace === 'dm' ? `The owner was sent a DM at ${at}.`
        : `The owner was sent a Discord message at ${at}.`;
  const line = a.dm === 'sent' ? `${sent}${a.dmNote ? ` The bot's note: ${a.dmNote}` : ''}`
    : a.dm === 'pending' ? 'The message to the owner is being sent.'
      : a.dm === 'failed' ? `The message to the owner could not be sent: ${a.dmError || 'no reason was given'}. The manager tries again every hour.`
        : a.dm === 'unknown' ? (a.dmError ? `The manager can't confirm the owner got the message: ${a.dmError}.` : "The bot did not answer within 30 s, so the manager can't confirm the owner got the message.")
          : 'This app has no notify-owner hook, so this failure shows only here.';
  return [tip(line)];
}

// backupStatusHtml (:2782): the backup lines of one family.
export function backupStatusLines(f: BackupFamilyStatus | null | undefined, when: When): DbLine[] {
  if (!f) return [];
  const testAlert = f.alerts && f.alerts.test ? [backupTestLine(f, when), ...backupAlertLines(f.alerts.test, when)] : [];
  if (!f.enabled) return [err('Backups are off for this bot: no backup is taken and none is deleted.'), ...testAlert];
  if (f.skip === 'scope') return testAlert;
  if (f.skip === 'seed') return [tip('Backups of this copy start after its seed finishes.'), ...testAlert];
  const file = f.lastFile || '';
  const failing = f.alerts && f.alerts.dumps;
  const lines: DbLine[] = [];
  if (f.paused) lines.push(tip(`The database container is not running, so no backup is taken; nothing can change in it while it is stopped. Newest backup: ${f.lastFile ? file : 'none'}.`));
  else if (failing) lines.push(err(`No backup has succeeded since ${when(f.failingSince || failing.since || NaN)}.${f.lastError ? ` Last error: ${f.lastError}.` : ''}`));
  else if (f.lastError) lines.push(err(`The last backup attempt failed: ${f.lastError}. The next attempt starts at the next hour.`));
  if (f.listError) lines.push(err(`${f.listError}.`));
  if (!f.paused && f.lastFile) {
    lines.push(tip(f.family === 'copy'
      ? `Last backup of this copy: ${file} at ${when(f.lastAt ?? NaN)}, ${f.dataAt ? `holding changes up to ${when(f.dataAt)}` : 'holding no replayed change yet'}.`
      : `Last backup: ${file} at ${when(f.lastAt ?? NaN)}. Hourly backups are kept for 48 hours and daily ones for 30 days; the daily backup and its test restore run at ${hourText(f.hour)}.`));
  } else if (!f.paused && !failing && !f.lastError && !f.listError) {
    lines.push(tip('No backup yet; the first one starts within a minute.'));
  }
  lines.push(...backupAlertLines(failing, when), backupTestLine(f, when), ...backupAlertLines(f.alerts && f.alerts.test, when));
  return lines;
}

// fleetBackupErrorHtml (:2644); its Dismiss button is part 3's.
export function fleetBackupErrorLines(fb: FleetBackupStatus | null | undefined, when: When): DbLine[] {
  return [...(fb?.restoreError ? [err(`${fb.restoreError}.`)] : []), ...backupStatusLines(fb?.main, when)];
}

// copyDumpHtml (:2819).
export function copyDumpLines(info: BackupFamilyStatus | null | undefined, when: When): DbLine[] {
  return info ? backupStatusLines(info, when) : [];
}

// fleetBackupListHtml's empty text (:2666).
export function emptyBackupsText(fb: FleetBackupStatus): string {
  return !fb.enabled
    ? 'Backups are off for this bot: no backup is taken and none is deleted.'
    : fb.scoped === false
      ? 'No backups. Scheduled dumps are skipped: the stored database URL does not point at the database this manager provisioned.'
      : fb.scoped === null
        ? 'No backups. Scheduled dumps are paused: the stored database URL could not be read, so its scope cannot be checked.'
        : 'No backup yet; the first one starts within a minute.';
}

const because = (r: { text: string }) => (r.text ? ` (${r.text})` : '');

// refreshStateLine (:3451).
export function stateLineText(r: Outcome<{ summary?: string }> | null): string {
  if (!r) return 'Reading the state.';
  if (r.ok === true) return r.value.summary || '';
  if (r.ok === false) return r.text;
  return `No answer from the manager, so the bot's state can't be shown${because(r)}.`;
}

// memoryLineText (:3460).
export function memoryLineText(r: Outcome<MemoryAnswer> | null): string {
  const lead = 'Room to reshard beside the running shards: ';
  if (!r) return `${lead}reading.`;
  if (r.ok === null) return `${lead}can't confirm: no answer from the manager${because(r)}`;
  if (r.ok === false) return `${lead}can't confirm: ${r.text || 'the manager refused the reading'}`;
  const res = r.value;
  const m = res.memory || {};
  if (m.running === false) return `${lead}the bot is not running`;
  const sent = res.sent?.kind === 'no-hook' ? "; this bot's build does not take the reading"
    : res.sent?.kind === 'failed' ? (res.sent.unknown ? `; can't confirm the bot got it: ${res.sent.error}` : `; the bot did not get it: ${res.sent.error}`) : '';
  if (m.room === true || m.room === false) return `${lead}${m.room ? 'yes' : 'no'}, ${m.freeMb} MB free for ${m.useMb} MB${sent}`;
  return `${lead}can't confirm: ${m.error || 'no reading'}${sent}`;
}

// connectionLineText (:3480); '' when nothing needs saying.
export function connectionLineText(r: Outcome<ConnectionsAnswer> | null): string {
  const lead = "Connections: can't confirm that this database accepts every connection the bot can open: ";
  if (!r) return '';
  if (r.ok === null) return `${lead}no answer from the manager${because(r)}`;
  if (r.ok === false) return `${lead}${r.text}`;
  const c = r.value.connections || {};
  if (c.state === 'unread') return `${lead}${c.error}`;
  if (c.state !== 'read' || (c.count ?? 0) <= (c.allowed ?? 0)) return '';
  const machines = c.machines === 1 ? '1 machine' : `${c.machines} machines`;
  const tail = c.overlap ? ' (during a reshard beside the running shards)' : '';
  return `Connections: this bot's ${machines} seen in the last 7 days can open up to ${c.count} connections to this database at once${tail}, more than the ${c.allowed} it accepts (max_connections ${c.max}, less ${c.reserved} that Postgres reserves for superusers and for roles granted pg_use_reserved_connections). A connection past that is refused.`;
}

/** The retrying text the page shows for a refused or unanswered read, with the reason. */
export function retryingText(page: string, r: { ok: false | null; text: string }): string {
  return r.ok === null ? `${page} (no answer: ${r.text}); retrying.` : `${page}${r.text ? ` (${r.text})` : ''}; retrying.`;
}

// renderSeedBanner (:2711): the seed lines of the main layout; Cancel and Dismiss are M5's.
export function seedBannerLines(r: Outcome<ReplicaAnswer> | null): DbLine[] {
  if (!r) return [];
  if (r.ok !== true) return [tip(retryingText('Could not read the seed state', r))];
  const rep = r.value.replica || null;
  if (rep && rep.provisioning) {
    const p = rep.provisioning;
    return [
      ...seedWarningLines(rep.pinsWarning),
      tip(`${seedPurposeText(p.purpose, p.auto, p.cause)}: ${p.phase} (${p.forSeconds}s). Seeding copies the whole database; large fleets take a while.`),
      ...seedDumpLines(p),
      ...(p.cancelRequested ? [tip('Cancelling at the next step...')] : []),
    ];
  }
  if (rep && rep.parkedSeed) {
    const k = rep.parkedSeed;
    return [...seedWarningLines(rep.pinsWarning), err(`${seedPurposeText(k.purpose, k.auto, k.cause)} stopped during ${k.phase}: ${k.lastError}`), ...seedDumpLines(k)];
  }
  return seedWarningLines(rep && rep.pinsWarning);
}

// joinStateHtml (:3294).
export function joinStateLines(join: ReplicaAnswer['join']): DbLine[] {
  if (!join) return [];
  return [
    tip(`Joined the main at ${join.host}:${Number(join.port)} (${join.machine}).`),
    ...(join.codeUnreadable ? [err('The stored join code no longer decrypts (the manager encryption key changed or was lost); paste the join code again.')] : []),
    ...(join.addressesError ? [err(join.addressesError)] : []),
  ];
}

// alertOutcomeHtml (:3302).
export function alertOutcomeLines(rebuild: ReplicaAnswer['rebuild'], key: string): DbLine[] {
  const a = rebuild && rebuild.alerts ? rebuild.alerts[key] : null;
  return a && a.outcome ? [tip(a.outcome)] : [];
}

// rebuiltLineHtml (:3308).
export function rebuiltLines(rebuild: ReplicaAnswer['rebuild'], replica: ReplicaAnswer['replica']): DbLine[] {
  if (!rebuild || !rebuild.rebuilt || (replica && replica.rebuiltShown)) return [];
  return [tip(rebuild.rebuilt)];
}

// rebuildLineHtml (:3314).
export function rebuildLines(rebuild: ReplicaAnswer['rebuild']): DbLine[] {
  if (!rebuild || !rebuild.text) return [];
  return [err(rebuild.text), ...(rebuild.kind === 'held' ? alertOutcomeLines(rebuild, 'held') : [])];
}

// replicaConsentHtml (:3115).
export const REPLICA_CONSENT = 'This copy follows the main and never takes over by itself.';

// renderFleetReplica (:3125): the copy layout's lines; every button and form in it is M5's.
export function replicaLines(r: Outcome<ReplicaAnswer> | null, when: When): DbLine[] {
  if (!r) return [tip('Loading...')];
  if (r.ok !== true) return [err(retryingText("Failed to load the copy's status", r))];
  const res = r.value;
  const rep = res.replica || { present: false };
  const parked = rep.parkedSeed || null;
  const errLines: DbLine[] = [
    ...seedWarningLines(rep.pinsWarning),
    ...(parked
      ? [err(`${seedPurposeText(parked.purpose, parked.auto, parked.cause)} stopped during ${parked.phase}: ${parked.lastError}`), ...seedDumpLines(parked), ...alertOutcomeLines(res.rebuild, 'stopped')]
      : rep.seedNote ? [err(rep.seedNote)]
        : rep.lastError ? [err(`The copy needs attention: ${rep.lastError}`)]
          : !rep.live && rep.probeError ? [err(`Could not read the copy (${rep.probeError}); its state is unknown.`)] : []),
    ...rebuiltLines(res.rebuild, rep),
  ];
  if (rep.provisioning) {
    const p = rep.provisioning;
    return [
      ...errLines,
      tip(`${seedPurposeText(p.purpose, p.auto, p.cause)}: ${p.phase} (${p.forSeconds}s). Seeding copies the whole database; large fleets take a while.`),
      ...(p.cancelRequested ? [tip('Cancelling at the next step...')] : p.cancelable ? [] : [tip('Past the point of cancelling: the copy is complete and its database is starting.')]),
    ];
  }
  if (!rep.record) return [...errLines, ...joinStateLines(res.join)];
  const live = rep.live || {};
  const lagText = live.caughtUp === true
    ? (live.receiverStatus === 'streaming' ? ', caught up' : '; it replayed everything received before the link dropped')
    : live.replayLagSeconds != null ? `, replay lag ${live.replayLagSeconds.toFixed(1)}s`
      : live.clockSkewSeconds != null ? `; this machine's clock runs ${live.clockSkewSeconds}s behind the main's, so the time behind cannot be read` : '';
  const laggingBehind = live.caughtUp !== true && live.replayLagSeconds != null && live.replayLagSeconds > 60;
  const state: DbLine[] = !rep.live ? []
    : !live.running ? [err("The copy's database container is not running: it is receiving nothing and falls further behind every minute.")]
      : live.inRecovery === false
        ? [err('This copy has been PROMOTED outside the manager and no longer follows a main. Take over makes it this machine\'s main database: the manager checks the old main, then raises this copy\'s generation before any bot can use it. If the promotion was a mistake, press Remove replica and add the copy again; that deletes every write made to this copy since the promote.')]
        : live.receiverStatus !== 'streaming'
          ? [err(`Not streaming from the main (${live.receiverStatus || 'no connection'})${lagText}. Check the main's published port, then re-seed if the gap is large.`)]
          : [tip(`Receiver: streaming${lagText}${laggingBehind ? ' - a take-over now would lose that much' : ''}`)];
  const rec = rep.record;
  return [
    ...errLines,
    tip(`Follows ${rec.primaryHost}:${rec.primaryPort}${rec.publicHost ? `; this copy serves at ${rec.publicHost}:${rec.hostPort} once you promote it` : ''}.`),
    ...joinStateLines(res.join),
    tip(REPLICA_CONSENT),
    ...state,
    ...rebuildLines(res.rebuild),
    ...copyDumpLines(res.copyBackup, when),
    tip('The bot on this instance learns its copy when its container is next recreated: Apply on the card (in place) or Restart.'),
  ];
}

// renderFleetReplication (:2829): the main's Replication lines; the Enable form, Apply bound, Drop slot, join code and
// Disable are M5's.
export function replicationLines(r: Outcome<{ replication?: ReplicationStatus }> | null, when: When): DbLine[] {
  if (!r) return [tip('Loading...')];
  if (r.ok !== true) return [err(retryingText('Failed to load replication status', r))];
  const rep = r.value.replication || { enabled: false };
  if (!rep.enabled) return [tip('A copy of this database on another machine. Without one, this machine dying takes the database with it and no other machine can take over as the main.')];
  const live = rep.live;
  const reach = rep.reachability;
  const reachAge = reach && (reach.ageSeconds ?? 0) > 0 ? ` (checked ${reach.ageSeconds}s ago)` : '';
  const reachLines: DbLine[] = !live ? []
    : reach && reach.ok ? [tip(`Endpoint reachable from containers${reachAge}`)]
      : reach && reach.unchecked ? [tip(`Endpoint not checked: ${reach.error || 'no reason given'}`)]
        : reach ? [
          tip(`Endpoint NOT reachable from containers yet (restart pending, or blocked by a firewall / hairpin routing): ${reach.error || 'no response'}${reachAge}`),
          tip('Other machines need this address and port open. A machine that cannot open a port can be the main only when it runs alone.'),
        ] : [];
  const keepBytes = (() => {
    const m = /^(-?\d+)\s*(kB|MB|GB|TB)?$/.exec((live && live.slotWalKeep) || '');
    if (!m || Number(m[1]) < 0) return null;
    const f = ({ kB: 1024, MB: 1048576, GB: 1073741824, TB: 1099511627776 } as Record<string, number>)[m[2] || 'MB'];
    return Number(m[1]) * f;
  })();
  const slots = (live && live.slots) || [];
  const fleetSlots = slots.filter((s) => s.fleet);
  const otherSlots = slots.filter((s) => !s.fleet);
  const fleetSlotLines: DbLine[] = fleetSlots.length === 0
    ? [tip('No copy attached: this machine dying would take this bot\'s database with it. Paste the join code into another machine\'s manager to add one.')]
    : fleetSlots.map((s) => {
      const who = s.machine ? `The copy on ${s.machine} (slot ${s.slot})` : `The copy on slot ${s.slot}${s.clientAddr ? ` (${s.clientAddr})` : ''}`;
      const retained = s.retainedBytes != null ? Math.round(s.retainedBytes / 1048576) : null;
      if (s.walStatus === 'lost') return err(`${who} was invalidated: it kept more WAL than the bound. The copy's manager rebuilds it from this database when it next checks; drop the slot if that copy is gone.`);
      if (s.walStatus === 'unreserved') return err(`${who} is past the WAL bound and about to be invalidated; reconnect the copy now.`);
      if (!s.active) return err(`${who} is not connected: its copy, if it still exists, is falling behind${retained != null ? `, and the slot keeps ${retained} MB of WAL` : ''}. Drop the slot if that copy is gone.`);
      if (s.state !== 'streaming') return err(`${who} is ${s.state || 'not streaming'}, not streaming: the copy is going stale.`);
      const lag = s.replayLagSeconds;
      const behind = s.behindBytes == null ? '' : s.behindBytes === 0 ? ', caught up' : s.behindBytes < 1048576 ? ', less than 1 MB behind' : `, ${Math.round(s.behindBytes / 1048576)} MB behind`;
      const lagText = `${behind}${lag != null ? `, replay lag ${lag.toFixed(1)}s` : ''}`;
      const warn = lag != null && lag > 60;
      const retain = keepBytes !== null && s.retainedBytes != null && s.retainedBytes > keepBytes / 2 ? ` - retains ${retained} MB of WAL (bound ${Math.round(keepBytes / 1048576)} MB)` : '';
      return tip(`${who}: streaming${lagText}${warn ? ' - a take-over by it now would lose that much' : ''}${retain}`);
    });
  const slotLines: DbLine[] = !live ? [] : [...fleetSlotLines, ...otherSlots.map((s) => tip(`Slot ${s.slot} (not a fleet copy): ${s.walStatus}${s.active ? ', active' : ''}`))];
  const keepTip = live && live.slotWalKeep === '-1' ? ' - WAL retention UNBOUNDED' : live && live.slotWalKeep ? ` - WAL bound ${live.slotWalKeep}` : '';
  const dbState = live ? (live.sslOn ? '' : ' - ssl not active yet, restart the instance') : rep.probeError ? ` - could not read the database (${rep.probeError})` : ' - database not running';
  return [
    tip(`Replication endpoint ${rep.publicHost}:${rep.hostPort} (TLS required off this machine)${dbState}${keepTip}`),
    ...(rep.disablingSince ? [err(`A Disable of replication started on ${when(Date.parse(rep.disablingSince))} did not finish: some of its steps may already have run (the replication login may be revoked, the copies' slots dropped). Press Disable replication to finish it.`)] : []),
    ...reachLines,
    ...slotLines,
  ];
}

// renderFleetSwitch (:3577) and switchPanelHtml (:3592): the Move lines; every button is M5's.
export function switchLines(bot: Bot, r: Outcome<SwitchAnswer> | null): DbLine[] {
  if (!r) return [];
  if (r.ok === null) return [err(`No answer from the manager (${r.text}); the move controls are not shown. Retrying.`)];
  if (r.ok === false) return [err(retryingText('Could not read the move state', r))];
  const view = r.value;
  const lines = (view.lines || []).map(tip);
  if (!bot.fleetDb) return lines;
  const db = bot.fleetDb;
  const g = view.generation;
  const genLines: DbLine[] = !g || db.replacedBy || db.mainConflict || db.pushBroken || db.handover || db.receive || view.takeover ? []
    : g.error ? [tip(`Can't confirm this database's generation: ${g.error}`)]
      : [tip(`This database is the main${g.machine ? `: ${g.machine},` : ','} generation ${g.generation}${g.since ? ` since ${g.since.slice(0, 10)} ${g.since.slice(11, 16)} UTC` : ''}.`)];
  return [...genLines, ...lines];
}

/**
 * The host folder of a bot's dumps by hostBotDirFor's rule (src/docker/containerManager.ts:118): HOST_DATA_DIR, else DATA_DIR
 * resolved; null when the dbm process has neither.
 */
export function hostDataRoot(env: NodeJS.ProcessEnv): string | null {
  const raw = env.HOST_DATA_DIR || (env.DATA_DIR ? path.resolve(env.DATA_DIR) : '');
  return raw ? raw.replace(/\\/g, '/').replace(/\/+$/, '') : null;
}

export function backupFolder(botId: string): string {
  return `backups/${botId}/fleet-postgres`;
}

/** Where the focused dump and its counts file are, for copying them off the machine. */
export function hostPathLines(root: string | null, botId: string, file: string, hasCounts: boolean): string[] {
  return [
    root ? `Folder on the host: ${root}/${backupFolder(botId)}` : `In the manager's data folder: ${backupFolder(botId)}`,
    `Dump: ${file}`,
    ...(hasCounts ? [`Counts file: ${file}.json`, 'Copy both files to keep the counts check.'] : [`Counts file: ${file}.json could not be read.`]),
  ];
}

const MOVE_OUT_HEAD = (file: string) => `The backup ${file} is ready and is downloading.`;
const MOVE_OUT_HEAD_END = 'with the bot in Maintenance or Off.';

/**
 * moveOutFleet's text (fleetMove.ts:551) with where the backup is on this host instead of the page's download (plan
 * section 5, owner question M4 Q1 option (a)): its sentence up to "with the bot in Maintenance or Off." becomes the
 * file and the moved- name; the rest of the route's text is kept. A text that starts otherwise is kept whole after the
 * host path lines. The counts file is not copied: it names its own dump (fleetBackup.ts:1231), readRestoreMeta reads only
 * <dump>.json (:2075), refuses one that names another dump (:2089) and restores a moved- dump without one (:2078).
 */
export function moveOutText(root: string | null, botId: string, file: string, text: string): string {
  const paths = hostPathLines(root, botId, file, true).slice(0, 2).join('; ');
  const end = text.indexOf(MOVE_OUT_HEAD_END);
  if (!text.startsWith(MOVE_OUT_HEAD(file)) || end < 0) return `${paths}. ${text}`;
  const stem = file.replace(/^pre-move-/, '').replace(/\.dump$/, '');
  const rest = text.slice(end + MOVE_OUT_HEAD_END.length).trim();
  return `The backup ${file} is ready. ${paths}. Copy only the dump to the other machine's backups folder for that bot, under a name that `
    + `does not end in .dump (for example moved-${stem}.part), then rename it moved-${stem}.dump there and restore it with the bot in `
    + `Maintenance or Off. Do not copy its counts file ${file}.json: it names ${file}, so a copy renamed to match the moved- dump is `
    + `refused, and a moved- dump restores without one.${rest ? ` ${rest}` : ''}`;
}

// loadOrphanBackups (:1491), with the host folder.
export function orphanLines(r: Outcome<{ folders?: Array<{ id: string; dumps: number | null; folder: string }> }> | null, root: string | null): string[] {
  if (!r) return [];
  if (r.ok === null) return [`The manager could not list database dumps of removed instances: no answer (${r.text})`];
  if (r.ok === false) return [`The manager could not list database dumps of removed instances: ${r.text || 'no answer'}`];
  const folders = r.value.folders || [];
  if (folders.length === 0) return [];
  return [
    "Database dumps of removed instances are kept in the manager's data folder:",
    ...folders.map((f) => `${root ? `${root}/${f.folder}` : f.folder}: ${f.dumps === null ? 'the folder could not be read' : `${f.dumps} ${f.dumps === 1 ? 'dump' : 'dumps'}`}`),
  ];
}

// OFF_START_REFUSAL (src/docker/containerManager.ts:3837), the start route's answer for an Off bot (:3846).
export const OFF_START_REFUSAL = 'This bot is Off. Choose Running in its State window to start it';

// startOffRefusal (:956).
export function startOffRefusal(bot: Bot): string {
  return bot.maintenance?.state === 'off' ? OFF_START_REFUSAL : '';
}

// heldLineText (:3729).
export function heldLineText(held: Held | null | undefined): string {
  if (!held) return '';
  const line = held.state === 'yes' ? "The bot's last answer: it saved every change it held."
    : held.state === 'no' ? `The bot reports changes it could not save: ${Number(held.guilds) || 0} guild(s), ${Number(held.files) || 0} file(s). Its log names them.`
      : held.state === 'unknown' ? "The manager can't confirm the bot saved the changes it holds: its last answer did not say."
        : held.state === 'stopped' ? 'The bot was stopped without confirming that it saved what it held.'
          : '';
  return line && held.note ? `${line} The bot's note: ${held.note}` : line;
}

export type HeldAction = 'restart' | 'update' | 'apply' | 'off' | 'stop';

// heldWarningText (:3740): what a stop or recreate drops; '' when there is nothing to warn about.
export function heldWarningText(bot: Bot | undefined, action: HeldAction): string {
  const m = bot && bot.maintenance;
  const held = m && m.state !== 'running' ? m.held : null;
  if (!bot || bot.status !== 'running' || !held || (held.state !== 'no' && held.state !== 'unknown')) return '';
  const lead = held.state === 'no'
    ? `The bot reports changes it could not save: ${Number(held.guilds) || 0} guild(s), ${Number(held.files) || 0} file(s).`
    : "The manager can't confirm the bot saved the changes it holds.";
  const note = held.note ? ` The bot's note: ${held.note}` : '';
  const does = { restart: 'A restart stops the bot and drops', update: 'An update recreates the bot and drops', apply: 'Apply recreates the bot and drops', off: 'Off stops the bot and drops', stop: 'Stopping the bot drops' }[action];
  const ask = { restart: 'Restart anyway?', update: 'Update anyway?', apply: 'Apply anyway?', off: 'Choose Off anyway?', stop: 'Stop anyway?' }[action];
  return `${lead}${note} ${does} ${held.state === 'no' ? 'those changes' : 'any it still holds'}. ${ask}`;
}

// stateWindowHtml's notes (:3812).
export const KIND_NOTES: Record<string, string> = {
  database: "The manager blocks the bot's database login and closes its open connections, so no process of this bot, on any machine, can write until Running.",
  copy: 'This machine holds a live copy of the database. Only the manager of the machine with the main database can block the login; here the bot is put into maintenance through its own answer.',
  external: "The bot's database is not run by this manager, so its login is not blocked; the bot is put into maintenance through its own answer.",
  json: 'The bot keeps its data in files, so it is put into maintenance through its own answer.',
  none: 'This app declares no lifecycle hooks, so Maintenance is not available; Off stops the bot.',
};

// stateWindowHtml's line under each state (:3819).
export function stateLineFor(state: string, kind: string | null | undefined): string {
  if (state === 'running') return 'The bot runs normally.';
  if (state === 'maintenance') return 'The bot stays online and answers every command with the message below; no module code runs. Members who join get no welcome or auto-role, messages earn no XP, and reminders that fall due fire when maintenance ends.';
  return `The bot is stopped.${kind === 'database' ? " Its database keeps running for backups and copies, with the bot's login blocked." : ''}`;
}

// migrateHtml (:3763): the record and last lines; the button is the screen's M key.
export function migrateRecordLines(view: MigrateView, when: When): string[] {
  const at = (v: string | number | undefined) => when(typeof v === 'number' ? v : Date.parse(v ?? ''));
  return [
    ...(view.record ? [`Migration to ${migrateName(view.record.to)}, opened ${at(view.record.openedAt)}: ${view.record.text || ''}`] : []),
    ...(view.last ? [`Last migration (${at(view.last.at)}): ${view.last.text}`] : []),
  ];
}

// migrateConfirmText (:3778).
export function migrateConfirmText(bot: Bot, view: MigrateView): string {
  const name = bot.displayName || bot.id;
  const steps = 'The bot restarts once into maintenance, then copies its data while it stays in Maintenance.';
  const adopt = (x: string, extra: string[]) => {
    const parts = ['the bot does not restart', ...extra];
    const said = parts.length < 3 ? parts.join(', and ') : `${parts.slice(0, -1).join(', ')}, and ${parts[parts.length - 1]}`;
    return ` If the bot is already running a move to ${x} that the manager did not start, the manager follows that move instead: ${said}.`;
  };
  if (view.to === 'postgres') {
    const where = view.companion ? 'the managed Postgres on this server' : `Postgres at ${String(view.destination).replace(/^([^/]*:[^/]*):(\d+)\//, '[$1]:$2/')}`;
    return `Migrate ${name}'s data to ${where}? ${steps} Once the copy is checked, its Data Backend becomes Postgres and it leaves Maintenance. Its JSON files stay in its data folder.${adopt('Postgres', [])}`;
  }
  const sharers = view.sharers && view.sharers.length ? ` ${view.sharers.join(', ')} use the same database: they are stopped for the migration and stay stopped after it.` : '';
  const fence = view.fenced ? " While the migration runs, the database refuses every new connection but this bot's and the manager's, so any other bot or program that uses it and is not named here gets login errors until the migration ends; its open connections under another database login are closed, and while one under this bot's own login stays open, the move fails with nothing switched." : '';
  return `Migrate ${name}'s data to JSON files? ${steps} Once the copy is checked, the database store is renamed aside (kept, not deleted), its Data Backend becomes JSON files and it leaves Maintenance.${sharers}${fence}${adopt('JSON files', [
    ...(view.sharers && view.sharers.length ? ['no bot named above is stopped while that move runs'] : []),
    ...(view.fenced ? ['the database stays open to other connections'] : []),
  ])}`;
}

// startMigrate's acceptance (:3807), with the terminal's screen name.
export function migrateAcceptedText(view: MigrateView, channelClosed = false): string {
  const lead = view.record
    ? `The manager goes on with the open migration to ${migrateName(view.to ?? undefined)}`
    : `The manager accepted the migration to ${migrateName(view.to ?? undefined)}`;
  return channelClosed
    ? `${lead}; the event channel is closed, so this screen does not show its progress: press Esc, then T, to follow it.`
    : `${lead}; the State screen shows its progress and its outcome`;
}

// The page's line under the backup list (:2617).
export const RESTORE_TIP = 'Restoring a backup rewinds every guild\'s data on this database at once. The database is fenced (it refuses every connection but the manager\'s and is read-only) and a fresh safety dump is taken under that fence before anything changes (skipped only when the database itself is missing).';

/** How a dump from elsewhere is brought in (owner question M4 Q1, option (a)): copied into the backups folder. */
export function copyInText(root: string | null, botId: string): string {
  const where = root ? `${root}/${backupFolder(botId)} on the host` : `${backupFolder(botId)} in the manager's data folder`;
  return `A dump from elsewhere: copy it into ${where}. It restores when its counts file <name>.dump.json is copied beside it under the name it was written with: the counts file names its dump, and one renamed to fit another dump is refused. A dump named moved-<anything>.dump restores without a counts file, as a move: this machine becomes the bot's main. Copy it under a name that does not end in .dump (for example <name>.part) and rename it once the copy is complete: this screen lists every .dump file, and a restore of a file still being copied fails after the database was dropped (the safety dump is kept). A copied dump named hourly-<time>.dump or daily-<time>.dump whose time is older than 48 hours (hourly) or 30 days (daily) is deleted at the next trim.`;
}

// saveFleetBackupConfig's outcomes (:3910).
export function scheduleOutcome(r: Outcome<BackupConfigAnswer>): { ok: boolean | null; text: string; stored: { enabled: boolean; hour: number } | null } {
  if (r.ok !== true) {
    return r.ok === null
      ? { ok: null, text: "No answer from the manager, so the backup settings change can't be confirmed. Check whether it took effect before trying again.", stored: null }
      : { ok: false, text: r.text || 'Failed to save backup settings', stored: null };
  }
  const res = r.value;
  const fb = res.fleetBackup;
  const valid = !!fb && typeof fb.enabled === 'boolean' && typeof fb.hour === 'number';
  const stored = valid ? { enabled: fb!.enabled as boolean, hour: fb!.hour as number } : null;
  if (res.success === true && stored) return { ok: true, text: `Backup settings saved: backups ${stored.enabled ? 'on' : 'off'}, daily backup and test restore at ${String(stored.hour).padStart(2, '0')}:00.`, stored };
  if (res.success !== true && stored) return { ok: false, text: res.error || 'The backup settings were changed elsewhere. Nothing was saved.', stored };
  if (res.success === true) return { ok: null, text: "Can't confirm the backup settings: the manager did not return them. Reopen this screen to see what is stored.", stored: null };
  return { ok: false, text: res.error || 'Failed to save backup settings', stored: null };
}

// restoreSharersText (:3946).
export function restoreSharersText(r: Outcome<RestorePreview>, botId: string): string {
  if (r.ok === null) return 'The manager did not answer the list of other instances that share it; the ones docker shows running when the restore starts are stopped';
  const res = r.ok === true ? r.value : { success: false, error: r.text };
  if (!res.success || !Array.isArray(res.instances)) return `The manager could not list the other instances that share it (${res.error || 'no answer'}); the ones docker shows running when the restore starts are stopped`;
  const others = res.instances.filter((i) => i.id !== botId);
  if (others.length === 0) return 'No other instance on this manager shares it';
  const names = others.map((i) => `${i.displayName} (${i.running === true ? 'running now' : i.running === false ? 'stopped now' : 'docker did not answer'})`);
  return `Other instances on this manager share it: ${names.join(', ')}. Each one docker shows running when the restore starts is stopped`;
}

// restoreFleetBackupFile's question (:3961 to :3962), with the terminal's screen names.
export function restoreConfirmLines(file: string, sharers: string): string[] {
  const moved = file.startsWith('moved-') ? " This backup was made for a move: restoring it makes this machine's database the main, with a generation above the file's and this database's." : '';
  return [
    `Restore "${file}"?${moved}`,
    `The bot must be in Maintenance or Off (its State screen); otherwise the restore is refused and nothing changes. A dump whose counts file is missing (an uploaded backup has none and is allowed), unreadable or does not fit the dump is refused before anything changes. Restoring rewinds EVERY guild's data on this database at once. ${sharers}, and a fresh safety dump is taken under a write fence: from then until the restore ends, the database refuses every connection but the manager's, is read-only and has its sessions closed. The dump is skipped only when the database itself is missing; if it fails, nothing is restored. The database is then dropped and rebuilt from the chosen dump, and the restored claim numbers of guilds and shards are raised above the highest one the bot used before, with every restored shard claim expired, so a process that ran before the restore can no longer save over the restored data, and every shard can be taken. Right after the rebuild, every restored table is counted and compared with the dump's counts file; if they differ, the bot writes nothing (its login stays blocked), the other instances stay stopped, and Running is refused until you restore a dump again (the safety dump, when one was taken, holds the database as it was) or dismiss the notice to keep the restored data. A bot in Maintenance stays online answering with its message during and after the restore; an Off bot stays stopped. When you choose Running, the bot is asked to restart and load the restored data; the State screen says whether it confirmed that, and when it did not, restart the bot by hand. If the rebuild fails, the database stays read-only and Running is refused until a restore succeeds or you dismiss the notice. Do not start the other instances from CasaOS until the restore ends: one started before the drop refuses the restore, and one started after it keeps the database read-only until a restore runs with it stopped.`,
  ];
}

// restoreFleetBackupFile's outcomes (:3967 to :3990); the page's alerts become sentences of the same text.
export function restoreOutcome(file: string, r: Outcome<RestoreAnswer>): { ok: boolean | null; text: string } {
  if (r.ok === null) return { ok: null, text: 'No answer from the manager; the restore may still be running. Check its state before trying again.' };
  const res: RestoreAnswer = r.ok === true ? r.value : { success: false, error: r.text };
  if (res.success !== true) {
    const failed = res.error || 'Restore failed';
    return { ok: false, text: res.steps && res.steps.restored ? `${failed} The data was restored, but the lane finished WITH PROBLEMS: ${res.error || ''}` : failed };
  }
  const s = res.steps || {};
  const claims = typeof s.shardClaimsRaised === 'number' ? `${(s.guildsRaised || []).length} guild(s) raised to claim ${s.claimRaisedTo}, ${s.shardClaimsRaised} shard claim(s) raised above ${s.claimFloor}, ${s.shardClaimsExpired} restored shard claim(s) expired`
    : typeof s.shardClaimsExpired === 'number' ? `no claim number raised (none was used before), ${s.shardClaimsExpired} restored shard claim(s) expired`
      : Array.isArray(s.guildsRaised) ? `${s.guildsRaised.length} guild(s) raised to claim ${s.claimRaisedTo}` : 'no claim number raised (none was used before)';
  const c = s.counts;
  const counts = !c || typeof c !== 'object' ? ''
    : c.result === 'matched' ? `, ${c.tables} tables and ${c.rows} rows matched the dump's counts`
      : typeof c.tables === 'number' ? `, ${c.tables} tables and ${c.rows} rows restored, not compared (an uploaded backup has no counts file)`
        : `, not compared (an uploaded backup has no counts file), and the restored tables could not be counted (${c.text})`;
  const bot = s.botState === 'off' ? 'the bot stays off' : 'the bot stays in maintenance';
  const movedLine = typeof s.generation !== 'number' ? '' : file.startsWith('moved-')
    ? `. This machine is the main now (generation ${s.generation}); the Database screen shows whether the owner was sent a switch notice`
    : `. The database's main generation is ${s.generation} now, above the dump's and the one it had before the restore`;
  const done = `Restore complete: ${s.preRestoreDump ? 'safety dump taken' : 'no safety dump (the database was missing)'}${counts}, ${claims}, ${bot}, stopped ${(s.stopped || []).length}, restarted ${(s.restarted || []).length}${movedLine}${res.note ? `. ${res.note}` : ''}`;
  return { ok: true, text: res.warning ? `${done} Restore finished WITH A WARNING: ${res.warning}` : done };
}

// The dismiss question: the page asks nothing; the terminal says what dismissing keeps.
export const DISMISS_LINES = [
  'Dismiss the restore notice?',
  'Running is refused until a restore succeeds or this notice is dismissed. Dismissing keeps the data the restore left in the database as the bot\'s data.',
];

// dismissFleetRestoreError's outcomes (:2651), with the route's dismissed false said.
export function dismissOutcome(r: Outcome<{ success?: boolean; error?: string; dismissed?: boolean }>): { ok: boolean | null; text: string } {
  if (r.ok === null) return { ok: null, text: "No answer from the manager, so the dismiss can't be confirmed. Check whether it took effect before trying again." };
  const res = r.ok === true ? r.value : { success: false, error: r.text };
  if (res.success !== true) return { ok: false, text: res.error || 'Could not dismiss the restore notice' };
  return res.dismissed ? { ok: true, text: 'Restore notice dismissed.' } : { ok: true, text: 'No restore notice stood, so nothing was dismissed.' };
}

// decommissionFleetDb's question (:2935).
export const DECOMMISSION_LINES = [
  'Decommission this database?',
  "The database container and its volume on this machine are DESTROYED. A fresh safety dump is taken first under a write fence (while it runs, the database refuses every connection but the manager's, is read-only and has its sessions closed) and kept with the backups; if the fence or the dump fails, nothing is destroyed. If anything still uses this database, it goes down until you restore that dump into a re-provisioned database, and a copy streaming from it on another machine loses its source.",
  'The instance must be stopped first.',
];

// decommissionFleetDb's outcomes (:2937 to :2946).
export function decommissionOutcome(r: Outcome<{ success?: boolean; error?: string; dumpFile?: string; warning?: string }>): { ok: boolean | null; text: string } {
  if (r.ok === null) return { ok: null, text: 'No answer from the manager; the decommission may still be running. Check its state before trying again.' };
  const res = r.ok === true ? r.value : { success: false, error: r.text };
  if (res.success !== true) return { ok: false, text: res.error || 'Decommission refused' };
  if (res.warning) return { ok: false, text: `Database decommissioned${res.dumpFile ? `; safety dump kept: ${res.dumpFile}` : ''}. ${res.warning}` };
  return {
    ok: true,
    text: res.dumpFile
      ? `Database decommissioned; safety dump kept: ${res.dumpFile}.`
      : "Database decommissioned; no dump was taken (its volume no longer existed - an earlier attempt's dump, if any, is in the backups list).",
  };
}
