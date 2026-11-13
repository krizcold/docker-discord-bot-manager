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

const load = (restore: any) => {
  const seen = { confirm: [] as string[], messages: [] as Array<[string, string]>, alerts: [] as string[] };
  const ctx = vm.createContext({
    api: async (method: string) => (method === 'GET' ? { success: true, instances: [] } : restore),
    confirm: (text: string) => { seen.confirm.push(text); return restore !== undefined; },
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

const STEPS = { botState: 'maintenance', preRestoreDump: 'pre.dump', guildsRaised: ['g1', 'g2'], claimRaisedTo: 8, stopped: ['w'], restarted: ['w'] };
const line = (counts: string) => `Restore complete: safety dump taken${counts}, 2 guild(s) raised to claim 8, the bot stays in maintenance, stopped 1, restarted 1. The note.`;
const success = async (counts?: unknown) => {
  const { ctx, seen } = load({ success: true, steps: counts === undefined ? STEPS : { ...STEPS, counts }, note: 'The note.' });
  await ctx.restoreFleetBackupFile('a', 'old.dump');
  return seen.messages[seen.messages.length - 1];
};

const CONFIRM_A = ' A dump whose counts file is missing (an uploaded backup has none and is allowed), unreadable or does not fit the dump is refused before anything changes.';
const CONFIRM_B = " Right after the rebuild, every restored table is counted and compared with the dump's counts file; if they differ, the bot writes nothing (its login stays blocked), the other instances stay stopped, and Running is refused until you restore a dump again (the safety dump, when one was taken, holds the database as it was) or dismiss the notice to keep the restored data.";

describe('NM18 restoreFleetBackupFile', () => {
  it('U1 matched counts follow the safety clause', async () => {
    expect(await success({ result: 'matched', tables: 2, rows: 3, text: null }))
      .toEqual(['success', line(", 2 tables and 3 rows matched the dump's counts")]);
  });

  it('U2 an uploaded backup with totals', async () => {
    expect(await success({ result: 'unrecorded', tables: 2, rows: 3, text: null }))
      .toEqual(['success', line(', 2 tables and 3 rows restored, not compared (an uploaded backup has no counts file)')]);
  });

  it('U3 an uploaded backup whose tables could not be counted', async () => {
    expect(await success({ result: 'unrecorded', tables: null, rows: null, text: 'x' }))
      .toEqual(['success', line(', not compared (an uploaded backup has no counts file), and the restored tables could not be counted (x)')]);
  });

  it('U4 no counts key leaves the line as it was', async () => {
    expect(await success()).toEqual(['success', line('')]);
  });

  it('U5 a restore whose counts differ shows the error and the restored-data alert', async () => {
    const error = "The dump old.dump was restored, but 1 table(s) differ from the counts recorded when the backup was taken: smdb_data.meta: 1 recorded, 0 restored. The bot stays in maintenance, and Running is refused while the notice on the Database window stands: restore a dump again (the pre-restore dump pre.dump holds the database as it was), or dismiss the notice to keep the restored data";
    const { ctx, seen } = load({ success: false, error, steps: { ...STEPS, restored: true, restarted: [] } });
    await ctx.restoreFleetBackupFile('a', 'old.dump');
    expect(seen.messages[seen.messages.length - 1]).toEqual(['error', error]);
    expect(seen.alerts).toEqual([`The data was restored, but the lane finished WITH PROBLEMS:\n\n${error}`]);
  });

  it('U6 the confirm names the counts check before the change and the comparison after the rebuild', async () => {
    const { ctx, seen } = load(undefined);
    await ctx.restoreFleetBackupFile('a', 'old.dump');
    const text = seen.confirm[0];
    expect(text).toContain(`otherwise the restore is refused and nothing changes.${CONFIRM_A} Restoring rewinds EVERY guild's data`);
    expect(text).toContain(`and every shard can be taken.${CONFIRM_B} A bot in Maintenance stays online`);
  });
});
