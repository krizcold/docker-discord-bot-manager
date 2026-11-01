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
const load = (names: string[]) => {
  const ctx = vm.createContext({ Date, String, JSON });
  vm.runInContext(['escapeHtml', 'stateName', ...names].filter(n => pageHtml.includes(`function ${n}(`)).map(pageFunction).join('\n'), ctx);
  return ctx;
};

const bot = { id: 'b1', displayName: 'Shop Bot' };
const view = (over: Record<string, unknown> = {}) => ({ hidden: false, to: 'postgres', refusal: null, destination: 'b1-fleet-postgres:5432/smdb', companion: true, sharers: [], record: null, last: null, ...over });

describe('the Migrate control in the State window', () => {
  const ctx = load(['migrateName', 'migrateHtml', 'migrateConfirmText', 'migrateBadges', 'heldLineText', 'stateWindowHtml']);
  it('the button names the direction with its title', () => {
    const html = ctx.migrateHtml(bot, view());
    expect(html).toContain('Migrate to Postgres');
    expect(html).toContain('title="Copy this bot&#39;s data to Postgres and switch to it"');
  });
  it('hidden for an app without the setting or hooks; disabled with the refusal as its title', () => {
    expect(ctx.migrateHtml(bot, view({ hidden: true }))).toBe('');
    const html = ctx.migrateHtml(bot, view({ refusal: 'Migrate runs with the bot in Maintenance; choose Maintenance in State first; nothing was changed' }));
    expect(html).toContain('disabled');
    expect(html).toContain('Migrate runs with the bot in Maintenance; choose Maintenance in State first; nothing was changed');
  });
  it('the open record line and the last outcome line', () => {
    const html = ctx.migrateHtml(bot, view({ record: { to: 'file', openedAt: '2026-10-31T10:00:00.000Z', text: 'Migration mgr-a is running' }, to: 'file', last: { at: '2026-10-30T10:00:00.000Z', text: 'The data moved.' } }));
    expect(html).toContain('Migration to JSON files, opened ');
    expect(html).toContain(': Migration mgr-a is running');
    expect(html).toContain('Last migration (');
    expect(html).toContain('): The data moved.');
  });
  it('the confirm texts', () => {
    expect(ctx.migrateConfirmText(bot, view())).toBe("Migrate Shop Bot's data to the managed Postgres on this server? The bot restarts once into maintenance, then copies its data while it stays in Maintenance. Once the copy is checked, its Data Backend becomes Postgres and it leaves Maintenance. Its JSON files stay in its data folder. If the bot is already running a move to Postgres that the manager did not start, the manager follows that move instead: the bot does not restart.");
    expect(ctx.migrateConfirmText(bot, view({ companion: false, destination: 'db.example:5432/app' }))).toMatch(/^Migrate Shop Bot's data to Postgres at db\.example:5432\/app\?/);
    expect(ctx.migrateConfirmText(bot, view({ to: 'file', companion: false, destination: null, sharers: ['Other', 'Third'] }))).toBe("Migrate Shop Bot's data to JSON files? The bot restarts once into maintenance, then copies its data while it stays in Maintenance. Once the copy is checked, the database store is renamed aside (kept, not deleted), its Data Backend becomes JSON files and it leaves Maintenance. Other, Third use the same database: they are stopped for the migration and stay stopped after it. If the bot is already running a move to JSON files that the manager did not start, the manager follows that move instead: the bot does not restart, and no bot named above is stopped while that move runs.");
  });
  it('the badges: running, waiting', () => {
    const running = ctx.migrateBadges({ activeOp: 'migrate', migrate: { to: 'postgres', phase: 'following', text: 'Migration mgr-a is running' } });
    expect(running).toContain('Migrating to Postgres');
    expect(running).toContain('Stop and Delete are refused until the manager finishes the migration or leaves it waiting for you');
    expect(ctx.migrateBadges({ activeOp: null, migrate: { to: 'postgres', phase: 'waiting', text: 'press Migrate' } })).toContain('Migration waiting');
    expect(ctx.migrateBadges({ activeOp: null, migrate: null })).toBe('');
  });
  it('the State window renders the control', () => {
    const html = ctx.stateWindowHtml(bot, { state: 'maintenance', kind: 'json', message: '', migrate: view() });
    expect(html).toContain('Migrate to Postgres');
  });
  it('a bot:migrate case beside bot:maintenance', () => {
    expect(pageHtml).toMatch(/case 'bot:migrate':/);
  });
  it.each([
    [null, 'The manager accepted the migration to Postgres; the State window shows its progress and its outcome'],
    [{ to: 'postgres', phase: 'waiting' }, 'The manager goes on with the open migration to Postgres; the State window shows its progress and its outcome'],
  ])('C-5 the toast after an admitted press (record %o)', async (record, text) => {
    const shown: Array<[string, string]> = [];
    const c = vm.createContext({ Date, String, JSON, bots: [bot], confirm: () => true, showMessage: (k: string, t: string) => { shown.push([k, t]); },
      api: async (method: string) => (method === 'GET' ? { success: true, ...view({ record }) } : { success: true }) });
    vm.runInContext(['migrateName', 'migrateConfirmText', 'startMigrate'].map(pageFunction).join(String.fromCharCode(10)), c);
    await c.startMigrate('b1');
    expect(shown).toEqual([['info', text]]);
  });
});

describe('round 6 in the page', () => {
  const FENCE = " While the migration runs, the database refuses every new connection but this bot's and the manager's, so any other bot or program that uses it and is not named here gets login errors until the migration ends; its open connections under another database login are closed, and while one under this bot's own login stays open, the move fails with nothing switched.";
  it('O42 the Migrate confirm of a fenced move to file ends with MG-CONFIRM-FENCE; an unfenced one is as before', () => {
    const ctx = load(['migrateName', 'migrateConfirmText']);
    const plain = ctx.migrateConfirmText(bot, view({ to: 'file', companion: false, destination: null, sharers: ['Other'], fenced: false }));
    expect(plain).toBe(`Migrate Shop Bot's data to JSON files? The bot restarts once into maintenance, then copies its data while it stays in Maintenance. Once the copy is checked, the database store is renamed aside (kept, not deleted), its Data Backend becomes JSON files and it leaves Maintenance. Other use the same database: they are stopped for the migration and stay stopped after it. If the bot is already running a move to JSON files that the manager did not start, the manager follows that move instead: the bot does not restart, and no bot named above is stopped while that move runs.`);
    expect(ctx.migrateConfirmText(bot, view({ to: 'file', companion: false, destination: null, sharers: ['Other'], fenced: true }))).toBe(`Migrate Shop Bot's data to JSON files? The bot restarts once into maintenance, then copies its data while it stays in Maintenance. Once the copy is checked, the database store is renamed aside (kept, not deleted), its Data Backend becomes JSON files and it leaves Maintenance. Other use the same database: they are stopped for the migration and stay stopped after it.` + FENCE + ' If the bot is already running a move to JSON files that the manager did not start, the manager follows that move instead: the bot does not restart, no bot named above is stopped while that move runs, and the database stays open to other connections.');
  });
  it('O47, fenced with no sharer: the adopt sentence names the restart and the open database', () => {
    const ctx = load(['migrateName', 'migrateConfirmText']);
    const text: string = ctx.migrateConfirmText(bot, view({ to: 'file', companion: false, destination: null, sharers: [], fenced: true }));
    expect(text.endsWith(FENCE + ' If the bot is already running a move to JSON files that the manager did not start, the manager follows that move instead: the bot does not restart, and the database stays open to other connections.')).toBe(true);
  });
  it('O39 and O40 in the UI: the Enable notes end with urlKept', () => {
    const ctx = load(['fleetReplEnableNotes']);
    expect(ctx.fleetReplEnableNotes({ urlKept: 'X.' })).toBe(' X.');
  });
  it('C-2 the Enable message names applying the new database URL only when no URL was kept', () => {
    const ctx = load(['fleetReplEnableNotes', 'fleetReplEnabledText']);
    expect(ctx.fleetReplEnabledText({})).toBe('Replication enabled. Restart the instance to publish the port and apply the new database URL.');
    expect(ctx.fleetReplEnabledText({ urlKept: 'X.' })).toBe('Replication enabled. Restart the instance to publish the port. X.');
  });
});
