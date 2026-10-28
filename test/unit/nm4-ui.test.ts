import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';
import { describe, expect, it } from 'vitest';

const pageHtml = fs.readFileSync(path.resolve(__dirname, '../../src/webui/public/index.html'), 'utf8');
const pageFunction = (name: string): string => {
  let start = pageHtml.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`no function ${name}`);
  if (pageHtml.slice(start - 6, start) === 'async ') start -= 6;
  let i = pageHtml.indexOf('(', start);
  for (let depth = 0; ; i++) {
    if (pageHtml[i] === '(') depth++;
    else if (pageHtml[i] === ')' && --depth === 0) break;
  }
  i = pageHtml.indexOf('{', i);
  for (let depth = 0; ; i++) {
    if (pageHtml[i] === '{') depth++;
    else if (pageHtml[i] === '}' && --depth === 0) return pageHtml.slice(start, i + 1);
  }
};

type Answers = { preview: any; restore?: any };
const load = (answers: Answers) => {
  const seen = { confirm: [] as string[], messages: [] as Array<[string, string]>, alerts: [] as string[] };
  const ctx = vm.createContext({
    api: async (method: string, url: string) => (method === 'GET' ? answers.preview : answers.restore),
    confirm: (text: string) => { seen.confirm.push(text); return answers.restore !== undefined; },
    alert: (text: string) => { seen.alerts.push(text); },
    showMessage: (kind: string, text: string) => { seen.messages.push([kind, text]); },
    showNoAnswer: () => {},
    loadBots: async () => {},
    showFleetBackups: () => {},
    fleetBackupBotId: null,
    document: { getElementById: () => ({ querySelectorAll: () => [] }) },
    Array, String,
  });
  vm.runInContext(['restoreSharersText', 'restoreFleetBackupFile'].map(pageFunction).join('\n'), ctx);
  return { ctx, seen };
};

const PREVIEW = { success: true, instances: [{ id: 'a', displayName: 'A', running: true }, { id: 'w', displayName: 'W', running: false }] };
const SHARERS = 'Other instances on this manager share it: W (stopped now). Each one docker shows running when the restore starts is stopped';
const CONFIRM = (sharers: string) => `Restore "old.dump"?\n\nThe bot must be in Maintenance or Off (its State window); otherwise the restore is refused and nothing changes. Restoring rewinds EVERY guild's data on this database at once. ${sharers}, and a fresh safety dump is taken under a write fence: from then until the restore ends, the database refuses every connection but the manager's, is read-only and has its sessions closed. The dump is skipped only when the database itself is missing; if it fails, nothing is restored. The database is then dropped and rebuilt from the chosen dump, and every guild's claim number is raised above the highest one the bot used before, so a process that ran before the restore can no longer save over the restored data. A bot in Maintenance stays online answering with its message during and after the restore; an Off bot stays stopped. When you choose Running, the bot is asked to restart and load the restored data; the State window says whether it confirmed that, and when it did not, restart the bot by hand. If the rebuild fails, the database stays read-only and Running is refused until a restore succeeds or you dismiss the notice. Do not start the other instances from CasaOS until the restore ends: one started before the drop refuses the restore, and one started after it keeps the database read-only until a restore runs with it stopped.`;

describe('restoreSharersText leaves the bot itself out', () => {
  it('names the other sharers only', async () => {
    const { ctx } = load({ preview: PREVIEW });
    expect(await ctx.restoreSharersText('a')).toBe(SHARERS);
  });

  it('with only the bot itself, U-NONE', async () => {
    const { ctx } = load({ preview: { success: true, instances: [PREVIEW.instances[0]] } });
    expect(await ctx.restoreSharersText('a')).toBe('No other instance on this manager shares it');
  });

  it('a failed list keeps the old words with "other"', async () => {
    const { ctx } = load({ preview: { success: false, error: 'boom' } });
    expect(await ctx.restoreSharersText('a')).toBe('The manager could not list the other instances that share it (boom); the ones docker shows running when the restore starts are stopped');
  });
});

describe('restoreFleetBackupFile', () => {
  it('the confirm text is U-CONFIRM', async () => {
    const { ctx, seen } = load({ preview: PREVIEW });
    await ctx.restoreFleetBackupFile('a', 'old.dump');
    expect(seen.confirm).toEqual([CONFIRM(SHARERS)]);
  });

  const note = 'The note.';
  const rows: Array<[string, any, string]> = [
    ['maintenance, guilds raised', { botState: 'maintenance', preRestoreDump: 'pre.dump', guildsRaised: ['g1', 'g2'], claimRaisedTo: 8, stopped: ['w'], restarted: ['w'] },
      'Restore complete: safety dump taken, 2 guild(s) raised to claim 8, the bot stays in maintenance, stopped 1, restarted 1. The note.'],
    ['off, guilds raised', { botState: 'off', preRestoreDump: 'pre.dump', guildsRaised: [], claimRaisedTo: 3, stopped: ['a', 'w'], restarted: ['w'] },
      'Restore complete: safety dump taken, 0 guild(s) raised to claim 3, the bot stays off, stopped 2, restarted 1. The note.'],
    ['maintenance, no claim raised', { botState: 'maintenance', preRestoreDump: null, guildsRaised: null, claimRaisedTo: null, stopped: [], restarted: [] },
      'Restore complete: no safety dump (the database was missing), no claim number raised (none was used before), the bot stays in maintenance, stopped 0, restarted 0. The note.'],
    ['off, no claim raised', { botState: 'off', preRestoreDump: 'pre.dump', guildsRaised: null, claimRaisedTo: null, stopped: [], restarted: [] },
      'Restore complete: safety dump taken, no claim number raised (none was used before), the bot stays off, stopped 0, restarted 0. The note.'],
  ];
  it.each(rows)('success line: %s', async (_name, steps, line) => {
    const { ctx, seen } = load({ preview: PREVIEW, restore: { success: true, steps, note } });
    await ctx.restoreFleetBackupFile('a', 'old.dump');
    expect(seen.messages[seen.messages.length - 1]).toEqual(['success', line]);
  });
});

describe('the restore notice and its Dismiss (N3)', () => {
  const page = (calls: string[]) => {
    const ctx = vm.createContext({
      api: async (method: string, url: string) => { calls.push(`${method} ${url}`); return { success: true, dismissed: true }; },
      showMessage: () => {}, showNoAnswer: () => {}, loadBots: async () => {}, showFleetBackups: () => {},
      backupStatusHtml: () => '', escapeHtml: (t: string) => t, fleetBackupBotId: 'b1', encodeURIComponent,
    });
    vm.runInContext(['fleetBackupErrorHtml', 'dismissFleetRestoreError'].map(pageFunction).join('\n'), ctx);
    return ctx;
  };

  it('Dismiss sends the time of the notice it shows', async () => {
    const calls: string[] = [];
    const ctx = page(calls);
    const html: string = ctx.fleetBackupErrorHtml({ restoreError: 'Restore of old.dump failed: x', restoreErrorAt: '2026-10-28T10:00:00.000Z' });
    expect(html).toContain("dismissFleetRestoreError('b1', '2026-10-28T10:00:00.000Z')");
    await ctx.dismissFleetRestoreError('b1', '2026-10-28T10:00:00.000Z');
    expect(calls).toEqual(['DELETE /bots/b1/fleet-backups/restore-error?at=2026-10-28T10%3A00%3A00.000Z']);
  });
});
