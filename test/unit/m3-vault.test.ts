import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import * as ink from 'ink';
import { render } from 'ink-testing-library';
import { createApp } from '../../src/cli/tui/app';
import { Session } from '../../src/cli/tui/session';
import { botList, fake, Fake, noAnswer, ok, refused } from './m2-fake';
import { botRow } from './m3-fake';

const App = createApp(ink);
vi.setConfig({ testTimeout: 20_000 });
const ESC = '\u001B';
const ENTER = '\r';
const TAB = '\t';
const BACKSPACE = '\u007F';
const CTRL = (c: string) => String.fromCharCode(c.charCodeAt(0) - 96);
const tabs = (n: number) => Array(n).fill(TAB) as string[];

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const flat = (frame: string) => frame.split('\n').map((l) => l.replace(/^\| /, '').replace(/\s*\|$/, '').trim()).join(' ').replace(/\s+/g, ' ');
const keyBar = (frame: string) => frame.split('\n').at(-2) ?? '';

// maskValue of src/webui/routes/vault.ts:96, so the masked forms below are the route's.
const mask = (v: string) => (!v || v.length <= 8 ? '****' : `${v.substring(0, 4)}****${v.substring(v.length - 4)}`);
const SECRET = 'sk-live-0123456789abcdef';
const TOKEN = 'MTIzNDU2Nzg5.token.value';

// GET /api/vault (vault.ts:129): standalone first (a hidden entry comes with value ''), deleted bots newest first
// (always hidden), then each bot with stored env (sensitive keys hidden).
const standalone = (entries = [
  { key: 'API_KEY', value: '', masked: mask(SECRET), hidden: true },
  { key: 'GUILD_ID', value: '123456', masked: mask('123456'), hidden: false },
]) => ({ id: 'standalone', name: 'Standalone', type: 'standalone', entries });
const deleted = (id: string, deletedAt: number, entries = [
  { key: 'DISCORD_TOKEN', value: '', masked: mask(TOKEN), hidden: true },
  { key: 'PREFIX', value: '', masked: mask('!'), hidden: true },
]) => ({ id, name: '[Deleted] oldbot', type: 'deleted', deletedAt, entries });
const instance = () => ({
  id: 'b1', name: 'mybot', type: 'instance', entries: [
    { key: 'DISCORD_TOKEN', value: '', masked: mask(TOKEN), hidden: true },
    { key: 'LOG_LEVEL', value: 'info', masked: mask('info'), hidden: false },
  ],
});
const emptyInstance = () => ({ id: 'b2', name: 'quietbot', type: 'instance', entries: [] });
const vaultBody = (groups: unknown[], over: Record<string, unknown> = {}) => ok({
  success: true, groups, vaultBroken: false, corruptCopies: [], secretKeyProblem: null, ...over,
});
const allGroups = () => [standalone(), deleted('d2', 2_000_000), deleted('d1', 1_000_000), instance(), emptyInstance()];
const done = () => ok({ success: true });

function base(groups: unknown[] = allGroups()): Fake {
  return fake()
    .on('GET', '/api/bots', botList([botRow()]))
    .on('GET', '/api/vault', vaultBody(groups));
}

async function openVault(f: Fake, rows = 60) {
  const session = new Session(f.client, () => 0);
  await session.refresh();
  const view = render(createElement(App, {
    machine: 'box1', session, onHandOff: vi.fn(), now: () => 0, vaultOptions: { retryMs: 100, date: (ms: number) => `day ${ms / 1_000_000}` },
  }));
  (view.stdout as unknown as { rows: number }).rows = rows;
  view.stdout.emit('resize');
  await tick();
  const frame = () => view.lastFrame() ?? '';
  const press = async (...keys: string[]) => {
    for (const k of keys) {
      view.stdin.write(k);
      await tick();
    }
  };
  const until = async (text: string) => {
    for (let i = 0; i < 100 && !flat(frame()).includes(text); i++) await tick(20);
    expect(flat(frame())).toContain(text);
  };
  const type = async (text: string) => {
    for (const ch of text) await press(ch);
  };
  expect(keyBar(frame())).toContain('V Vault');
  await press('v');
  await until('Credentials Vault');
  return { ...view, session, frame, press, until, type };
}

const calls = (f: Fake, method: string) => f.calls.filter((c) => c.method === method).map((c) => ({ path: c.path, body: c.body }));
const vaultReads = (f: Fake) => f.paths().filter((p) => p === 'GET /api/vault').length;

// From the Standalone header: API_KEY key and value, GUILD_ID key and value, the new key, value and Hidden, then the
// deleted groups (d2, d1) and mybot.
const AT = { apiValue: 2, guildKey: 3, guildValue: 4, newKey: 5, newValue: 6, newHidden: 7, d2: 8, d1: 9, mybot: 10 };

describe('m3 vault: reading', () => {
  it('V opens the vault; groups as the page paints them, hidden values as the masked form only', async () => {
    const f = base();
    const v = await openVault(f);
    await v.until('v Standalone (2)');
    const text = flat(v.frame());
    expect(text).toContain(`[API_KEY ] [${mask(SECRET)}`);
    expect(text).toContain('[GUILD_ID ] [123456');
    expect(text).toContain('[x] Hidden');
    expect(text).toContain('> [Deleted] oldbot day 2 (2)');
    expect(text).toContain('> [Deleted] oldbot day 1 (2)');
    expect(text).toContain('> mybot (2)');
    expect(text).not.toContain('quietbot');
    expect(v.frames.join('\n')).not.toContain(SECRET);
    v.unmount();
  });

  it('a group opens and closes with Enter, and an instance group shows its values as the route sends them', async () => {
    const v = await openVault(base());
    await v.press(...tabs(AT.mybot), ENTER);
    await v.until('v mybot (2)');
    expect(flat(v.frame())).toContain(`[DISCORD_TOKEN ] [${mask(TOKEN)}`);
    expect(flat(v.frame())).toContain('[LOG_LEVEL ] [info');
    expect(keyBar(v.frame())).not.toContain('Remove group');
    await v.press(ENTER);
    await v.until('> mybot (2)');
    expect(flat(v.frame())).not.toContain('LOG_LEVEL');
    await v.press(...tabs(0), '\u001B[A', '\u001B[A', ENTER);
    await v.until('v [Deleted] oldbot day 2 (2)');
    expect(keyBar(v.frame())).toContain('Ctrl+D Remove group');
    v.unmount();
  });

  it('a refused read, no answer and a reply that is not JSON say so, and the read is tried again', async () => {
    const f = base().on('GET', '/api/vault', refused(500, { success: false, error: 'Error: EACCES' }));
    const v = await openVault(f);
    await v.until('Could not load the vault: Error: EACCES; retrying.');
    f.on('GET', '/api/vault', vaultBody(allGroups()));
    await v.until('v Standalone (2)');
    expect(flat(v.frame())).not.toContain('Could not load');
    v.unmount();
    const g = base().on('GET', '/api/vault', noAnswer());
    const w = await openVault(g);
    await w.until('Could not load the vault: the manager did not answer (connect ECONNREFUSED 127.0.0.1:8080); retrying.');
    w.unmount();
    const h = base().on('GET', '/api/vault', { status: 502, ok: false, body: 'Bad Gateway' });
    const x = await openVault(h);
    await x.until('Could not load the vault: the manager did not answer (the reply was not JSON, HTTP 502); retrying.');
    x.unmount();
  });

  it('a failed reload keeps the last list and says so; an empty vault and the store banners show', async () => {
    const f = base();
    const v = await openVault(f);
    await v.until('v Standalone (2)');
    f.on('GET', '/api/vault', noAnswer());
    await v.press(CTRL('r'));
    await v.until('retrying. The list below is from the last successful load.');
    expect(flat(v.frame())).toContain('v Standalone (2)');
    v.unmount();
    const g = base([standalone([]), emptyInstance()]).on('GET', '/api/vault', vaultBody([standalone([])], {
      vaultBroken: true, corruptCopies: ['vault.json.corrupt-1'], secretKeyProblem: 'the key file is empty',
    }));
    const w = await openVault(g);
    await w.until('v Standalone (0)');
    const text = flat(w.frame());
    expect(text).toContain('Secrets cannot be saved: the key file is empty. Fix the key file and restart the manager.');
    expect(text).toContain('vault.json cannot be read, so saves are refused until it is repaired or replaced.');
    expect(text).toContain('Copies of damaged vault.json kept beside it: vault.json.corrupt-1.');
    w.unmount();
    const h = base([emptyInstance()]);
    const x = await openVault(h);
    await x.until('No credentials yet. Install a bot or add standalone entries.');
    x.unmount();
  });
});

describe('m3 vault: saving', () => {
  it('a standalone value is saved with the page body; Saved only on the route answer, then the list is read again', async () => {
    const f = base().on('PUT', '/api/vault/standalone/API_KEY', done());
    const v = await openVault(f);
    await v.press(...tabs(AT.apiValue));
    await v.type('new-secret-value');
    await v.until('*'.repeat(16));
    const reads = vaultReads(f);
    await v.press(ENTER);
    await v.until('Saved API_KEY.');
    expect(calls(f, 'PUT')).toEqual([{ path: '/api/vault/standalone/API_KEY', body: { value: 'new-secret-value' } }]);
    expect(vaultReads(f)).toBeGreaterThan(reads);
    expect(v.frames.join('\n')).not.toContain('new-secret-value');
    v.unmount();
  });

  it('a rename sends newKey; an unchanged key with no value saves nothing; a taken name shows the route text', async () => {
    const f = base().on('PUT', '/api/vault/standalone/GUILD_ID', refused(409, { success: false, error: 'An entry named API_KEY already exists in this group. Nothing was saved.' }));
    const v = await openVault(f);
    await v.press(...tabs(AT.apiValue), ENTER);
    await v.until('The key is unchanged and the value is empty, so nothing was saved.');
    expect(calls(f, 'PUT')).toEqual([]);
    await v.press(TAB, ...Array(8).fill(BACKSPACE));
    await v.type('API_KEY');
    await v.press(ENTER);
    await v.until('An entry named API_KEY already exists in this group. Nothing was saved.');
    expect(calls(f, 'PUT')).toEqual([{ path: '/api/vault/standalone/GUILD_ID', body: { newKey: 'API_KEY', value: '123456' } }]);
    expect(v.frames.map(flat).join(' ')).not.toContain('Saved');
    v.unmount();
  });

  it('a save with no answer says can not confirm and reads the list again', async () => {
    const f = base().on('PUT', '/api/vault/standalone/GUILD_ID', noAnswer());
    const v = await openVault(f);
    await v.press(...tabs(AT.guildValue), BACKSPACE);
    const reads = vaultReads(f);
    await v.press(ENTER);
    await v.until("can't confirm the save of GUILD_ID: the manager did not answer (connect ECONNREFUSED 127.0.0.1:8080). Check whether it took effect before trying again.");
    expect(vaultReads(f)).toBeGreaterThan(reads);
    v.unmount();
  });

  it("a deleted bot's entry saves through its group's route", async () => {
    const f = base().on('PUT', '/api/vault/deleted/PREFIX?groupId=d1', done());
    const v = await openVault(f);
    await v.press(...tabs(AT.d1), ENTER, TAB, TAB, TAB, TAB);
    await v.type('?');
    await v.press(ENTER);
    await v.until('Saved PREFIX.');
    expect(calls(f, 'PUT')).toEqual([{ path: '/api/vault/deleted/PREFIX?groupId=d1', body: { value: '?' } }]);
    v.unmount();
  });

  it("a bot's variable saves through its env route; no rename and no empty value", async () => {
    const f = base().on('PUT', '/api/bots/b1/env', ok({ success: true, removed: [], valid: true, missing: [], notApplied: true }));
    const v = await openVault(f);
    await v.press(...tabs(AT.mybot), ENTER, TAB, TAB, TAB, TAB);
    await v.press(...Array(4).fill(BACKSPACE), ENTER);
    await v.until("The value is empty, so nothing was saved. To remove a variable, use the bot's Env editor.");
    await v.type('debug');
    await v.press(ENTER);
    await v.until('LOG_LEVEL saved. The running bot still uses the old value until you Apply or Restart it.');
    expect(calls(f, 'PUT')).toEqual([{ path: '/api/bots/b1/env', body: { vars: { LOG_LEVEL: 'debug' } } }]);
    await v.press('\u001B[A');
    await v.type('X');
    await v.press(ENTER);
    await v.until("A bot instance variable cannot be renamed here; rename it in the bot's Env editor. Nothing was saved.");
    expect(calls(f, 'PUT')).toHaveLength(1);
    v.unmount();
  });
});

describe('m3 vault: deleting and adding', () => {
  it('a standalone delete asks first; another key cancels, Y deletes, and Deleted only on the route answer', async () => {
    const f = base().on('DELETE', '/api/vault/standalone/API_KEY', done());
    const v = await openVault(f);
    await v.press(TAB, CTRL('d'));
    await v.until('Delete API_KEY from the standalone vault? Its value cannot be recovered.');
    expect(keyBar(v.frame())).toContain('Y Delete');
    await v.press('n');
    await v.until('Cancelled: nothing was deleted.');
    expect(calls(f, 'DELETE')).toEqual([]);
    await v.press(CTRL('d'), 'y');
    await v.until('Deleted API_KEY.');
    expect(calls(f, 'DELETE')).toEqual([{ path: '/api/vault/standalone/API_KEY', body: undefined }]);
    v.unmount();
  });

  it('a delete refused or without answer says so', async () => {
    const f = base().on('DELETE', '/api/vault/standalone/API_KEY', refused(500, { success: false, error: 'vault.json could not be read, so nothing was saved' }));
    const v = await openVault(f);
    await v.press(TAB, CTRL('d'), 'y');
    await v.until('vault.json could not be read, so nothing was saved');
    expect(v.frames.map(flat).join(' ')).not.toContain('Deleted API_KEY');
    v.unmount();
    const g = base().on('DELETE', '/api/vault/standalone/API_KEY', noAnswer());
    const w = await openVault(g);
    await w.press(TAB, CTRL('d'), 'y');
    await w.until("can't confirm the delete of API_KEY: the manager did not answer");
    w.unmount();
  });

  it("a deleted bot's entry and its whole group are deleted after Y, through their routes", async () => {
    const f = base()
      .on('DELETE', '/api/vault/deleted/PREFIX?groupId=d1', done())
      .on('DELETE', '/api/vault/deleted-group/d2', done());
    const v = await openVault(f);
    await v.press(...tabs(AT.d1), ENTER, TAB, TAB, TAB, CTRL('d'));
    await v.until('Delete PREFIX from "[Deleted] oldbot"? Its value cannot be recovered.');
    await v.press('y');
    await v.until('Deleted PREFIX.');
    await v.press(...Array(20).fill('\u001B[A'), ...tabs(AT.d2), CTRL('d'));
    await v.until('Remove "[Deleted] oldbot" and all its saved credentials? This cannot be undone. It holds 2 entries.');
    await v.press('x');
    await v.until('Cancelled: nothing was deleted.');
    await v.press(CTRL('d'), 'y');
    await v.until('Removed "[Deleted] oldbot".');
    expect(calls(f, 'DELETE')).toEqual([
      { path: '/api/vault/deleted/PREFIX?groupId=d1', body: undefined },
      { path: '/api/vault/deleted-group/d2', body: undefined },
    ]);
    v.unmount();
  });

  it('a group the route no longer has shows its text; no answer says can not confirm', async () => {
    const f = base().on('DELETE', '/api/vault/deleted-group/d2', refused(404, { success: false, error: 'Group not found' }));
    const v = await openVault(f);
    await v.press(...tabs(AT.d2), CTRL('d'), 'y');
    await v.until('Group not found');
    v.unmount();
    const g = base().on('DELETE', '/api/vault/deleted-group/d2', noAnswer());
    const w = await openVault(g);
    await w.press(...tabs(AT.d2), CTRL('d'), 'y');
    await w.until(`can't confirm the removal of "[Deleted] oldbot": the manager did not answer`);
    w.unmount();
  });

  it('adds an entry hidden by default, or shown with Hidden off; a taken key and no answer say so', async () => {
    const f = base().on('POST', '/api/vault/standalone', done());
    const v = await openVault(f);
    await v.press(...tabs(AT.newKey));
    await v.type('NEW_KEY');
    await v.press(TAB);
    await v.type(' typed-secret ');
    expect(v.frames.join('\n')).not.toContain('typed-secret');
    await v.press(ENTER);
    await v.until('Added NEW_KEY.');
    await v.press(TAB, ' ', '\u001B[A', '\u001B[A');
    await v.type('PLAIN');
    await v.press(TAB);
    await v.type('shown');
    await v.until('[shown');
    await v.press(ENTER);
    await v.until('Added PLAIN.');
    expect(calls(f, 'POST')).toEqual([
      { path: '/api/vault/standalone', body: { key: 'NEW_KEY', value: 'typed-secret', hidden: true } },
      { path: '/api/vault/standalone', body: { key: 'PLAIN', value: 'shown', hidden: false } },
    ]);
    v.unmount();

    const g = base().on('POST', '/api/vault/standalone', refused(409, { success: false, error: 'A vault entry named API_KEY already exists; edit that entry instead. Nothing was saved.' }));
    const w = await openVault(g);
    await w.press(...tabs(AT.newKey), ENTER);
    await w.until('A key is required to add an entry.');
    expect(calls(g, 'POST')).toEqual([]);
    await w.type('API_KEY');
    await w.press(ENTER);
    await w.until('A vault entry named API_KEY already exists; edit that entry instead. Nothing was saved.');
    w.unmount();

    const h = base().on('POST', '/api/vault/standalone', noAnswer());
    const x = await openVault(h);
    await x.press(...tabs(AT.newKey));
    await x.type('K');
    await x.press(ENTER);
    await x.until("can't confirm the add of K: the manager did not answer");
    x.unmount();
  });
});

describe('m3 vault: edits across a reload', () => {
  it('an edit on the focused row and the new entry fields survive a reload', async () => {
    const f = base();
    const v = await openVault(f);
    await v.press(...tabs(AT.newKey));
    await v.type('KEEP');
    await v.press('\u001B[A');
    await v.type('77');
    await v.until('[12345677');
    const reads = vaultReads(f);
    await v.press(CTRL('r'));
    for (let i = 0; i < 50 && vaultReads(f) === reads; i++) await tick(20);
    await tick(100);
    expect(flat(v.frame())).toContain('[12345677');
    expect(flat(v.frame())).toContain('[KEEP');
    v.unmount();
  });

  it('a reload that drops the focused edited entry is held back with the page text until the row is left', async () => {
    const f = base();
    const v = await openVault(f);
    await v.press(...tabs(AT.guildValue));
    await v.type('9');
    f.on('GET', '/api/vault', vaultBody([standalone([{ key: 'API_KEY', value: '', masked: mask(SECRET), hidden: true }])]));
    await v.press(CTRL('r'));
    await v.until('The vault list was not refreshed (it changed elsewhere or a group was toggled), so your unsaved edit to GUILD_ID is kept. Save it or leave the row to refresh.');
    expect(flat(v.frame())).toContain('[1234569');
    await v.press('\u001B[A', '\u001B[A');
    await v.until('Your unsaved edit to GUILD_ID was dropped; it was not saved.');
    for (let i = 0; i < 50 && flat(v.frame()).includes('GUILD_ID ]'); i++) await tick(20);
    expect(flat(v.frame())).not.toContain('[GUILD_ID');
    expect(flat(v.frame())).toContain('v Standalone (1)');
    v.unmount();
  });

  it('leaving an edited row puts its values back, as the page does; Esc leaves without a question', async () => {
    const f = base();
    const v = await openVault(f);
    await v.press(...tabs(AT.guildValue));
    await v.type('0');
    await v.press(TAB);
    await v.until('Your unsaved edit to GUILD_ID was dropped; it was not saved.');
    expect(flat(v.frame())).toContain('[123456 ');
    await v.press(ESC);
    await v.until('Enter Open');
    expect(calls(f, 'PUT')).toEqual([]);
    v.unmount();
  });
});

describe('m3 fix 1: a held-back reload never hides the route result', () => {
  const withoutApi = () => vaultBody([standalone([{ key: 'GUILD_ID', value: '123456', masked: mask('123456'), hidden: false }])]);

  it('a confirmed delete of the edited row says Deleted, and the entry leaves the list', async () => {
    const f = base();
    f.on('DELETE', '/api/vault/standalone/API_KEY', () => {
      f.on('GET', '/api/vault', withoutApi());
      return done();
    });
    const v = await openVault(f);
    await v.press(...tabs(AT.apiValue));
    await v.type('x');
    await v.press(CTRL('d'), 'y');
    await v.until('Deleted API_KEY.');
    await v.until('v Standalone (1)');
    expect(flat(v.frame())).not.toContain('[API_KEY');
    expect(v.frames.map(flat).join(' ')).not.toContain('was not refreshed');
    v.unmount();
  });

  it('a rename with no answer keeps can not confirm, with the held-back text after it', async () => {
    const f = base();
    f.on('PUT', '/api/vault/standalone/GUILD_ID', () => {
      f.on('GET', '/api/vault', vaultBody([standalone([
        { key: 'API_KEY', value: '', masked: mask(SECRET), hidden: true },
        { key: 'RENAMED', value: '123456', masked: mask('123456'), hidden: false },
      ])]));
      return noAnswer();
    });
    const v = await openVault(f);
    await v.press(...tabs(AT.guildKey), ...Array(8).fill(BACKSPACE));
    await v.type('RENAMED');
    await v.press(ENTER);
    await v.until("can't confirm the save of GUILD_ID: the manager did not answer (connect ECONNREFUSED 127.0.0.1:8080). Check whether it took effect before trying again. The vault list was not refreshed");
    expect(v.frames.map(flat).join(' ')).not.toContain('Saved');
    v.unmount();
  });
});

describe('m3 fix 1: refused and unanswered vault actions', () => {
  it("a deleted bot's entry save: refused, then no answer, never Saved", async () => {
    const f = base().on('PUT', '/api/vault/deleted/PREFIX?groupId=d1', refused(404, { success: false, error: 'Entry not found' }));
    const v = await openVault(f);
    await v.press(...tabs(AT.d1), ENTER, TAB, TAB, TAB, TAB);
    await v.type('?');
    await v.press(ENTER);
    await v.until('Entry not found');
    f.on('PUT', '/api/vault/deleted/PREFIX?groupId=d1', noAnswer());
    await v.type('!');
    await v.press(ENTER);
    await v.until("can't confirm the save of PREFIX: the manager did not answer (connect ECONNREFUSED 127.0.0.1:8080).");
    expect(v.frames.map(flat).join(' ')).not.toContain('Saved');
    v.unmount();
  });

  it("a bot's variable: its warning, a refusal and no answer", async () => {
    const f = base().on('PUT', '/api/bots/b1/env', ok({
      success: true, removed: [], valid: true, missing: [],
      warning: 'Saved, but could not record that the running bot needs Apply or Restart to apply it: EACCES',
    }));
    const v = await openVault(f);
    await v.press(...tabs(AT.mybot), ENTER, TAB, TAB, TAB, TAB);
    await v.type('2');
    await v.press(ENTER);
    await v.until('LOG_LEVEL saved. Saved, but could not record that the running bot needs Apply or Restart to apply it: EACCES');
    f.on('PUT', '/api/bots/b1/env', refused(409, { success: false, error: 'Bot operation in progress (build); nothing was saved, retry when it completes' }));
    await v.type('3');
    const beforeRefusal = v.frames.length;
    await v.press(ENTER);
    await v.until('Bot operation in progress (build); nothing was saved, retry when it completes');
    expect(v.frames.slice(beforeRefusal).map(flat).join(' ')).not.toContain('LOG_LEVEL saved');
    f.on('PUT', '/api/bots/b1/env', noAnswer());
    await v.type('4');
    const beforeSilence = v.frames.length;
    await v.press(ENTER);
    await v.until("can't confirm the save of LOG_LEVEL: the manager did not answer");
    expect(v.frames.slice(beforeSilence).map(flat).join(' ')).not.toContain('LOG_LEVEL saved');
    expect(calls(f, 'PUT')).toHaveLength(3);
    v.unmount();
  });

  it("a deleted bot's single entry delete: refused, then no answer, never Deleted", async () => {
    const f = base().on('DELETE', '/api/vault/deleted/PREFIX?groupId=d1', refused(404, { success: false, error: 'Group not found' }));
    const v = await openVault(f);
    await v.press(...tabs(AT.d1), ENTER, TAB, TAB, TAB, CTRL('d'), 'y');
    await v.until('Group not found');
    f.on('DELETE', '/api/vault/deleted/PREFIX?groupId=d1', noAnswer());
    await v.press(CTRL('d'), 'y');
    await v.until("can't confirm the delete of PREFIX: the manager did not answer");
    expect(v.frames.map(flat).join(' ')).not.toContain('Deleted PREFIX');
    v.unmount();
  });
});

describe('m3 fix 1b: a reload during the question or the save', () => {
  // A failed read is tried again every 100 ms, and each try rebuilds the rows while the list stays.
  it('a delete confirmed after the rows were rebuilt still clears the edit, so the entry leaves', async () => {
    const f = base();
    const v = await openVault(f);
    f.on('GET', '/api/vault', noAnswer());
    await v.press(CTRL('r'));
    await v.press(...tabs(AT.apiValue));
    await v.type('x');
    await v.press(CTRL('d'));
    await v.until('Delete API_KEY from the standalone vault?');
    await tick(350);
    f.on('DELETE', '/api/vault/standalone/API_KEY', () => {
      f.on('GET', '/api/vault', vaultBody([standalone([{ key: 'GUILD_ID', value: '123456', masked: mask('123456'), hidden: false }])]));
      return done();
    });
    await v.press('y');
    await v.until('Deleted API_KEY.');
    await v.until('v Standalone (1)');
    expect(v.frames.map(flat).join(' ')).not.toContain('was not refreshed');
    v.unmount();
  });

  it('a save confirmed after the rows were rebuilt clears the edit, so leaving the row drops nothing', async () => {
    const f = base();
    const v = await openVault(f);
    f.on('GET', '/api/vault', noAnswer());
    await v.press(CTRL('r'));
    await v.press(...tabs(AT.apiValue));
    await v.type('new-secret');
    f.on('PUT', '/api/vault/standalone/API_KEY', async () => {
      await tick(350);
      f.on('GET', '/api/vault', vaultBody(allGroups()));
      return done();
    });
    await v.press(ENTER);
    await v.until('Saved API_KEY.');
    await tick(100);
    await v.press(TAB);
    await tick(100);
    expect(v.frames.map(flat).join(' ')).not.toContain('Your unsaved edit to API_KEY was dropped');
    v.unmount();
  });
});
