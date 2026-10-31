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

const PREVIEW = { success: true, instances: [{ id: 'a', displayName: 'A', running: true }, { id: 'w', displayName: 'W', running: false }] };
const load = (restore?: any) => {
  const seen = { confirm: [] as string[], messages: [] as Array<[string, string]> };
  const ctx = vm.createContext({
    api: async (method: string) => (method === 'GET' ? PREVIEW : restore),
    confirm: (text: string) => { seen.confirm.push(text); return restore !== undefined; },
    alert: () => {},
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

const SHARERS = 'Other instances on this manager share it: W (stopped now). Each one docker shows running when the restore starts is stopped';
const U_CONFIRM = `Restore "old.dump"?\n\nThe bot must be in Maintenance or Off (its State window); otherwise the restore is refused and nothing changes. Restoring rewinds EVERY guild's data on this database at once. ${SHARERS}, and a fresh safety dump is taken under a write fence: from then until the restore ends, the database refuses every connection but the manager's, is read-only and has its sessions closed. The dump is skipped only when the database itself is missing; if it fails, nothing is restored. The database is then dropped and rebuilt from the chosen dump, and the restored claim numbers of guilds and shards are raised above the highest one the bot used before, with every restored shard claim expired, so a process that ran before the restore can no longer save over the restored data, and every shard can be taken. A bot in Maintenance stays online answering with its message during and after the restore; an Off bot stays stopped. When you choose Running, the bot is asked to restart and load the restored data; the State window says whether it confirmed that, and when it did not, restart the bot by hand. If the rebuild fails, the database stays read-only and Running is refused until a restore succeeds or you dismiss the notice. Do not start the other instances from CasaOS until the restore ends: one started before the drop refuses the restore, and one started after it keeps the database read-only until a restore runs with it stopped.`;

const base = { botState: 'maintenance', preRestoreDump: 'pre.dump', stopped: ['w'], restarted: ['w'] };
const MOVED = 'moved-2026-10-30T10-00-00-000Z.dump';

describe('NM9 restoreFleetBackupFile', () => {
  const rows: Array<[string, string, any, string]> = [
    ['U1 with a floor', 'old.dump', { ...base, claimFloor: 7, guildsRaised: ['g1'], claimRaisedTo: 8, shardClaimsRaised: 2, shardClaimsExpired: 3 },
      'Restore complete: safety dump taken, 1 guild(s) raised to claim 8, 2 shard claim(s) raised above 7, 3 restored shard claim(s) expired, the bot stays in maintenance, stopped 1, restarted 1'],
    ['U1 with a floor, a moved- file', MOVED, { ...base, claimFloor: 7, guildsRaised: [], claimRaisedTo: 8, shardClaimsRaised: 2, shardClaimsExpired: 3, generation: 6 },
      'Restore complete: safety dump taken, 0 guild(s) raised to claim 8, 2 shard claim(s) raised above 7, 3 restored shard claim(s) expired, the bot stays in maintenance, stopped 1, restarted 1. This machine is the main now (generation 6); the Database window shows whether the owner was sent a switch notice'],
    ['U1b no floor', 'old.dump', { ...base, claimFloor: null, guildsRaised: null, claimRaisedTo: null, shardClaimsRaised: null, shardClaimsExpired: 3 },
      'Restore complete: safety dump taken, no claim number raised (none was used before), 3 restored shard claim(s) expired, the bot stays in maintenance, stopped 1, restarted 1'],
    ['U2 shard fields absent', 'old.dump', { ...base, guildsRaised: ['g1', 'g2'], claimRaisedTo: 8 },
      'Restore complete: safety dump taken, 2 guild(s) raised to claim 8, the bot stays in maintenance, stopped 1, restarted 1'],
    ['U2 shard fields null', 'old.dump', { ...base, guildsRaised: null, claimRaisedTo: null, shardClaimsRaised: null, shardClaimsExpired: null },
      'Restore complete: safety dump taken, no claim number raised (none was used before), the bot stays in maintenance, stopped 1, restarted 1'],
  ];
  it.each(rows)('%s', async (_n, file, steps, line) => {
    const { ctx, seen } = load({ success: true, steps });
    await ctx.restoreFleetBackupFile('a', file);
    expect(seen.messages[seen.messages.length - 1]).toEqual(['success', line]);
  });

  it('U3 the confirm is U-CONFIRM', async () => {
    const { ctx, seen } = load();
    await ctx.restoreFleetBackupFile('a', 'old.dump');
    expect(seen.confirm).toEqual([U_CONFIRM]);
  });
});
