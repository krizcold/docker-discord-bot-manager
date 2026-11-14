import { Bot } from './api';

/** Data column: only what the list route says; "-" when it says nothing, and null from the route means its env store read failed. */
export function dataText(bot: Bot, detail = false): string {
  if (bot.fleetDb || bot.fleetDbReplica) return 'Postgres';
  if (bot.dataPlace === 'json') return 'files';
  if (bot.dataPlace === 'outside') return 'outside';
  if ('dataPlace' in bot && bot.dataPlace === null) return detail ? "can't confirm: the bot's settings could not be read" : "can't confirm";
  return '-';
}

/** Copy column: the copy role the list route reports; it reports no sync state, so none is shown. */
export function copyText(bot: Bot): string {
  if (bot.fleetDbReplicaSeed) return bot.fleetDbReplicaSeed.phase ? `seed ${bot.fleetDbReplicaSeed.phase}` : 'seed';
  if (bot.fleetDbReplica?.copyCleared) return 'cleared';
  if (bot.fleetDbReplica) return 'copy here';
  if (bot.fleetDb?.replication) return 'main';
  return '-';
}

export function ago(at: number, now: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}

export function lastBackupText(bot: Bot, now: number, detail = false): string {
  const listError = bot.fleetBackup?.main?.listError || bot.fleetBackup?.copy?.listError;
  if (listError) return detail ? `can't confirm: ${listError}` : "can't confirm";
  const stamps = [bot.fleetBackup?.main?.lastAt, bot.fleetBackup?.copy?.lastAt].filter((s): s is number => typeof s === 'number');
  return stamps.length ? ago(Math.max(...stamps), now) : '-';
}

export function statusText(bot: Bot): string {
  const status = bot.status || '-';
  return bot.activeOp ? `${status} (${bot.activeOp})` : status;
}

export function updateText(bot: Bot): string {
  if (bot.updateCantConfirm) return `can't confirm: ${bot.updateCantConfirm}`;
  if (bot.sourceType === 'docker-image') return '-';
  if (bot.updateAvailable) return bot.behindBy ? `available, ${bot.behindBy} commits behind` : 'available';
  return 'none';
}

// Each width is the longest text the column shows plus one space: Status "replica-remove" (the longest op name),
// Data and Last backup "can't confirm", Copy "seed preparing" (a longer seed phase is cut). Bots takes the rest.
const FIXED: Array<[string, number]> = [['Status', 15], ['Data', 14], ['Copy', 15], ['Last backup', 14]];
const BOTS_MIN = 12;

function cell(text: string, width: number): string {
  return text.length >= width ? text.slice(0, width - 1) + ' ' : text.padEnd(width);
}

/** The columns that fit: Copy goes first when Bots would fall under its floor; below that the line is cut at the edge. */
function layout(inner: number): Array<{ name: string; width: number }> {
  const shown = FIXED.filter(([name]) => name !== 'Copy' || inner - 2 - FIXED.reduce((sum, [, w]) => sum + w, 0) >= BOTS_MIN);
  const fixed = shown.reduce((sum, [, w]) => sum + w, 0);
  return [{ name: 'Bots', width: Math.max(BOTS_MIN, inner - 2 - fixed) }, ...shown.map(([name, width]) => ({ name, width }))];
}

function line(prefix: string, texts: Record<string, string>, inner: number): string {
  return (prefix + layout(inner).map((c) => cell(texts[c.name], c.width)).join('').trimEnd()).slice(0, inner);
}

/** The list's Status cell: the running operation when there is one (the bot screen shows both). */
export function listStatusText(bot: Bot): string {
  return bot.activeOp || bot.status || '-';
}

export function listHeader(inner: number): string {
  return line('  ', { Bots: 'Bots', Status: 'Status', Data: 'Data', Copy: 'Copy', 'Last backup': 'Last backup' }, inner);
}

export function listRow(bot: Bot, selected: boolean, now: number, inner: number): string {
  const texts = {
    Bots: bot.displayName || bot.id, Status: listStatusText(bot), Data: dataText(bot), Copy: copyText(bot), 'Last backup': lastBackupText(bot, now),
  };
  return line(selected ? '> ' : '  ', texts, inner);
}

export function clock(at: number): string {
  return new Date(at).toTimeString().slice(0, 8);
}
