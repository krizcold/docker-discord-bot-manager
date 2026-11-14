import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import * as ink from 'ink';
import { render } from 'ink-testing-library';
import { createApp } from '../../src/cli/tui/app';
import { Session } from '../../src/cli/tui/session';
import { botList, fake, Fake, noAnswer, refused } from './m2-fake';
import {
  botRow, dbFailed, dbOk, editorVar, envBody, partlyRemoved, renameTaken, richVars, saved, TOKEN, VAULT_TOKEN, vaultBody, vaultValues,
} from './m3-fake';

const App = createApp(ink);
vi.setConfig({ testTimeout: 20_000 });
const UP = '\u001B[A';
const DOWN = '\u001B[B';
const LEFT = '\u001B[D';
const RIGHT = '\u001B[C';
const ESC = '\u001B';
const ENTER = '\r';
const TAB = '\t';
const BACKSPACE = '\u007F';
const CTRL = (c: string) => String.fromCharCode(c.charCodeAt(0) - 96);
const SECRET = 'c3'.repeat(32);
const ENV = '/api/bots/b1/env';

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const flat = (frame: string) => frame.split('\n').map((l) => l.replace(/^\| /, '').replace(/\s*\|$/, '').trim()).join(' ').replace(/\s+/g, ' ');
const keyBar = (frame: string) => frame.split('\n').at(-2) ?? '';

function base(vars: unknown[] = richVars(), over: Record<string, unknown> = {}): Fake {
  return fake()
    .on('GET', '/api/bots', botList([botRow(over)]))
    .on('GET', ENV, envBody(vars));
}

async function start(f: Fake) {
  const session = new Session(f.client, () => 0);
  await session.refresh();
  const view = render(createElement(App, {
    machine: 'box1', session, onHandOff: vi.fn(), now: () => 0, envOptions: { secret: () => SECRET, now: () => 0 },
  }));
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
  return { ...view, session, frame, press, until, type };
}

async function openEditor(f: Fake) {
  const v = await start(f);
  await v.press(ENTER);
  await v.until('Name mybot');
  await v.press('e');
  await v.until('Environment Variables: mybot');
  await v.until('Esc Cancel');
  return v;
}

const putBody = (f: Fake) => f.calls.filter((c) => c.method === 'PUT' && c.path === ENV).map((c) => c.body);

// Focus steps from the token's key: token value, STORAGE key and value, DEVS key, its two items, SHARDS key and value.
const TO_SHARDS_VALUE = [TAB, TAB, TAB, TAB, TAB, TAB, TAB, TAB];
const TO_SAVE = Array(30).fill(TAB) as string[];

describe('m3 env editor: opening and reading', () => {
  it('E opens the editor of a stopped bot; the bar names it', async () => {
    const f = base();
    const v = await start(f);
    await v.press(ENTER);
    await v.until('Name mybot');
    expect(v.frame().split('\n').slice(-3, -1).join(' ')).toMatch(/G Build logs {2}T State {2}E Env\s+C Config\s+X Delete\W+Esc Back/);
    await v.press('e');
    await v.until('Environment Variables: mybot');
    expect(f.paths()).toContain('GET /api/bots/b1/env');
    v.unmount();
  });

  it('a running bot offers no E, and E says why and calls nothing', async () => {
    const f = base(richVars(), { status: 'running' });
    const v = await start(f);
    await v.press(ENTER);
    await v.until('Name mybot');
    expect(keyBar(v.frame())).not.toContain('E Env');
    await v.press('e');
    await v.until('Stop the bot to edit environment variables.');
    expect(f.paths()).not.toContain('GET /api/bots/b1/env');
    v.unmount();
  });

  it('a bot with an operation in flight offers no E', async () => {
    const f = base(richVars(), { activeOp: 'build' });
    const v = await start(f);
    await v.press(ENTER, 'e');
    expect(keyBar(v.frame())).not.toContain('E Env');
    expect(f.paths()).not.toContain('GET /api/bots/b1/env');
    v.unmount();
  });

  it('a refused read shows the route text and nothing to save; Esc goes back', async () => {
    const f = base().on('GET', ENV, refused(404, { success: false, error: 'Bot not found' }));
    const v = await start(f);
    await v.press(ENTER, 'e');
    await v.until('Bot not found');
    expect(flat(v.frame())).not.toContain('Save');
    await v.press(ESC);
    await v.until('Name mybot');
    v.unmount();
  });

  it('a read with no answer, or a reply that is not JSON, says can not read', async () => {
    const f = base().on('GET', ENV, noAnswer());
    const v = await start(f);
    await v.press(ENTER, 'e');
    await v.until("can't read the environment variables of mybot: the manager did not answer (connect ECONNREFUSED 127.0.0.1:8080).");
    v.unmount();
    const g = base().on('GET', ENV, { status: 502, ok: false, body: '<html>Bad Gateway</html>' });
    const w = await start(g);
    await w.press(ENTER, 'e');
    await w.until("can't read the environment variables of mybot: the manager did not answer (the reply was not JSON, HTTP 502).");
    w.unmount();
  });

  it('shows the route banners: missing, undecryptable, store health', async () => {
    const f = base().on('GET', ENV, envBody(richVars(), {
      missing: ['DISCORD_TOKEN'], undecryptable: ['API_KEY'], storeBroken: true, corruptCopies: ['storage.json.corrupt-1'], secretKeyProblem: 'the key file is empty',
    }));
    const v = await openEditor(f);
    const text = flat(v.frame());
    expect(text).toContain('Missing required: DISCORD_TOKEN');
    expect(text).toContain('Stored but cannot be decrypted: API_KEY. Enter the value again, or restore the encryption key.');
    expect(text).toContain('Secrets cannot be saved: the key file is empty. Fix the key file and restart the manager.');
    expect(text).toContain('storage.json cannot be read, so saves are refused until it is repaired or replaced.');
    expect(text).toContain('Copies of damaged storage.json kept beside it: storage.json.corrupt-1.');
    v.unmount();
  });
});

describe('m3 env editor: rows', () => {
  it('shows each row kind with its label, required mark, description and placeholder', async () => {
    const v = await openEditor(base());
    await v.press(...TO_SAVE);
    const all = v.frames.map(flat).join(' ');
    expect(all).toContain('Discord Bot Token (required)');
    expect(all).toContain('Sensitive - leave blank to keep current');
    expect(all).toContain('Storage backend');
    expect(all).toContain('< JSON files >');
    expect(all).toContain('Where the bot keeps its data.');
    expect(all).toContain('Developer ids');
    expect(all).toContain('[111');
    expect(all).toContain('[222');
    expect(all).toContain('Ctrl+G generates a new random secret.');
    expect(all).toContain('Web login The login of the bot web page.');
    expect(all).toContain('Advanced Cache lifetime');
    expect(all).toContain('GATEWAY_PASS not used');
    expect(all).toContain("Not used: this deployment removes the bot's own login gateway (Auth: Auto).");
    expect(all).not.toContain('Database URL');
    v.unmount();
  });

  it('keeps an unknown stored select value as (current) and Left/Right chooses', async () => {
    const vars = richVars();
    (vars[1] as Record<string, unknown>).value = 'mongo';
    const v = await openEditor(base(vars));
    await v.until('< mongo (current) >');
    await v.press(TAB, TAB, TAB, RIGHT);
    await v.until('< JSON files >');
    await v.press(RIGHT);
    await v.until('< Postgres >');
    await v.press(RIGHT);
    await v.until('< mongo (current) >');
    v.unmount();
  });

  it('shows the conditional row and its required mark when STORAGE becomes postgres, and hides it again', async () => {
    const v = await openEditor(base());
    expect(flat(v.frame())).not.toContain('Database URL');
    await v.press(TAB, TAB, TAB, RIGHT);
    await v.until('Database URL (required)');
    await v.press(LEFT);
    for (let i = 0; i < 20 && flat(v.frame()).includes('Database URL'); i++) await tick(20);
    expect(flat(v.frame())).not.toContain('Database URL');
    v.unmount();
  });

  it('a list row adds, edits and removes items, and saves them joined with commas', async () => {
    const f = base().on('PUT', ENV, saved());
    const v = await openEditor(f);
    await v.press(TAB, TAB, TAB, TAB, TAB);
    expect(keyBar(v.frame())).toContain('Ctrl+A Add item');
    await v.press(CTRL('a'));
    await v.type('333');
    await v.until('[333');
    await v.press(UP, CTRL('d'));
    await v.press(...TO_SAVE, ENTER);
    await v.until('Environment variables of mybot saved');
    expect((putBody(f)[0] as { vars: Record<string, string> }).vars.DEVS).toBe('111,333');
    v.unmount();
  });

  it('Ctrl+G puts a generated secret in, masked in every frame, and the save sends it', async () => {
    const f = base().on('PUT', ENV, saved());
    const v = await openEditor(f);
    await v.press(...TO_SHARDS_VALUE, TAB, TAB);
    expect(keyBar(v.frame())).toContain('Ctrl+P Vault');
    await v.press(CTRL('g'));
    await v.until('*'.repeat(20));
    await v.press(...TO_SAVE, ENTER);
    await v.until('Environment variables of mybot saved');
    const body = putBody(f)[0] as { vars: Record<string, string> };
    expect(body.vars.SESSION_SECRET).toBe(SECRET);
    expect(v.frames.join('\n')).not.toContain(SECRET.slice(0, 12));
    v.unmount();
  });

  it('a typed secret never appears in any frame, and is sent as typed', async () => {
    const f = base().on('PUT', ENV, saved());
    const v = await openEditor(f);
    await v.press(TAB);
    await v.type('Typed.Secret.Token');
    await v.until('*'.repeat(18));
    await v.press(...TO_SAVE, ENTER);
    await v.until('Environment variables of mybot saved');
    expect((putBody(f)[0] as { vars: Record<string, string> }).vars.DISCORD_TOKEN).toBe('Typed.Secret.Token');
    expect(v.frames.join('\n')).not.toContain('Typed.Secret');
    expect(v.frames.join('\n')).not.toContain(TOKEN);
    v.unmount();
  });
});

describe('m3 env editor: save', () => {
  it('sends the page body: blank secrets left out, a removed stored key in removed, then Saved and the bot list re-read', async () => {
    const f = base().on('PUT', ENV, saved({ removed: ['LOG_LEVEL'] }));
    const v = await openEditor(f);
    await v.press(...TO_SAVE);
    for (let i = 0; i < 4; i++) await v.press(UP);
    expect(keyBar(v.frame())).toContain('Ctrl+D Remove');
    const reads = f.paths().filter((p) => p === 'GET /api/bots').length;
    await v.press(CTRL('d'));
    expect(flat(v.frame())).not.toContain('LOG_LEVEL');
    await v.press(...TO_SAVE, ENTER);
    await v.until('Environment variables of mybot saved; removed LOG_LEVEL.');
    await v.until('Name mybot');
    expect(putBody(f)).toEqual([{
      vars: { STORAGE: 'json', DATABASE_URL: 'postgres://db:5432/bot', DEVS: '111,222', SHARDS: '2', WEBUI_USER: 'admin', CACHE_TTL: '60' },
      removed: ['LOG_LEVEL'],
      renamed: {},
    }]);
    for (let i = 0; i < 50 && f.paths().filter((p) => p === 'GET /api/bots').length === reads; i++) await tick(20);
    expect(f.paths().filter((p) => p === 'GET /api/bots').length).toBeGreaterThan(reads);
    v.unmount();
  });

  it('a renamed blank secret goes in renamed, and the old key in removed', async () => {
    const f = base().on('PUT', ENV, saved());
    const v = await openEditor(f);
    await v.press(...Array(13).fill(BACKSPACE));
    await v.type('NEW_TOKEN');
    await v.press(...TO_SAVE, ENTER);
    await v.until('Environment variables of mybot saved');
    const body = putBody(f)[0] as { vars: Record<string, string>; removed: string[]; renamed: Record<string, string> };
    expect(body.renamed).toEqual({ NEW_TOKEN: 'DISCORD_TOKEN' });
    expect(body.removed).toEqual(['DISCORD_TOKEN']);
    expect(body.vars.NEW_TOKEN).toBeUndefined();
    v.unmount();
  });

  it('a running bot after the save is told to Apply or Restart', async () => {
    const f = base().on('PUT', ENV, saved({ notApplied: true }));
    const v = await openEditor(f);
    await v.press(...TO_SAVE, ENTER);
    await v.until('Environment variables of mybot saved. The running bot still uses the old values until you Apply or Restart it.');
    v.unmount();
  });

  it('a refusal shows the route text, keeps the editor, and never says saved', async () => {
    const f = base().on('PUT', ENV, renameTaken());
    const v = await openEditor(f);
    await v.press(...TO_SAVE, ENTER);
    await v.until('mybot: NEW_TOKEN is already stored');
    expect(keyBar(v.frame())).toContain('Enter Save');
    expect(v.frames.map(flat).join(' ')).not.toContain('saved;');
    expect(v.frames.map(flat).join(' ')).not.toMatch(/Environment variables of mybot saved/);
    v.unmount();
  });

  it('a save that removed some keys and not others shows the route text and leaves the editor', async () => {
    const f = base().on('PUT', ENV, partlyRemoved());
    const v = await openEditor(f);
    await v.press(...TO_SAVE, ENTER);
    await v.until('mybot: Saved and removed LOG_LEVEL, but could not edit docker-compose.yml, so CACHE_TTL is still stored; save again to retry the removal');
    await v.until('Name mybot');
    v.unmount();
  });

  it('a save with no answer says can not confirm and keeps the editor', async () => {
    const f = base().on('PUT', ENV, noAnswer());
    const v = await openEditor(f);
    await v.press(...TO_SAVE, ENTER);
    await v.until("can't confirm the environment variables of mybot were saved: the manager did not answer (connect ECONNREFUSED 127.0.0.1:8080).");
    expect(keyBar(v.frame())).toContain('Enter Save');
    expect(v.frames.map(flat).join(' ')).not.toMatch(/mybot saved/);
    v.unmount();
  });

  it('a reply that is not JSON is no answer, not a refusal', async () => {
    const f = base().on('PUT', ENV, { status: 502, ok: false, body: 'Bad Gateway' });
    const v = await openEditor(f);
    await v.press(...TO_SAVE, ENTER);
    await v.until("can't confirm the environment variables of mybot were saved: the manager did not answer (the reply was not JSON, HTTP 502).");
    v.unmount();
  });

  it('refuses duplicate keys, a bad number and an out-of-bounds number with nothing sent', async () => {
    const f = base().on('PUT', ENV, saved());
    const v = await openEditor(f);
    await v.press(...TO_SAVE, CTRL('n'));
    await v.type('STORAGE');
    await v.press(...TO_SAVE, ENTER);
    await v.until('Two rows hold the same key (STORAGE); give each row its own key, then save. Nothing was saved.');
    v.unmount();

    const g = base().on('PUT', ENV, saved());
    const w = await openEditor(g);
    await w.press(...TO_SHARDS_VALUE, BACKSPACE);
    await w.type('x');
    await w.press(...TO_SAVE, ENTER);
    await w.until('Not a number: SHARDS. Fix the value, then save. Nothing was saved.');
    await w.press(...Array(30).fill(UP));
    await w.press(...TO_SHARDS_VALUE, BACKSPACE);
    await w.type('40');
    await w.press(...TO_SAVE, ENTER);
    await w.until('Shards takes a whole number from 1 to 16. Nothing was saved.');
    expect(putBody(f)).toEqual([]);
    expect(putBody(g)).toEqual([]);
    w.unmount();
  });

  it('tests a changed database URL first; a failed test asks, another key cancels, Y saves', async () => {
    const f = base().on('POST', '/api/bots/b1/validate-db', dbFailed()).on('PUT', ENV, saved());
    const v = await openEditor(f);
    await v.press(TAB, TAB, TAB, RIGHT, TAB, TAB);
    await v.type('x');
    await v.press(...TO_SAVE, ENTER);
    await v.until('Database connection test failed: connection refused Hint: Check the host and port. Save anyway?');
    expect(f.calls.find((c) => c.path === '/api/bots/b1/validate-db')?.body).toEqual({ url: 'postgres://db:5432/botx' });
    expect(keyBar(v.frame())).toContain('Y Save anyway');
    await v.press('n');
    await v.until('Cancelled: nothing was saved.');
    expect(putBody(f)).toEqual([]);
    await v.press(ENTER);
    await v.until('Save anyway?');
    await v.press('y');
    await v.until('Environment variables of mybot saved');
    expect((putBody(f)[0] as { vars: Record<string, string> }).vars.DATABASE_URL).toBe('postgres://db:5432/botx');
    v.unmount();
  });

  it('an unchanged database URL is not tested, a passing test saves at once, and an unanswered test asks', async () => {
    const f = base().on('POST', '/api/bots/b1/validate-db', dbOk()).on('PUT', ENV, saved());
    const v = await openEditor(f);
    await v.press(TAB, TAB, TAB, RIGHT, ...TO_SAVE, ENTER);
    await v.until('Environment variables of mybot saved');
    expect(f.paths()).not.toContain('POST /api/bots/b1/validate-db');
    v.unmount();
    const g = base().on('POST', '/api/bots/b1/validate-db', dbOk()).on('PUT', ENV, saved());
    const w = await openEditor(g);
    await w.press(TAB, TAB, TAB, RIGHT, TAB, TAB);
    await w.type('y');
    await w.press(...TO_SAVE, ENTER);
    await w.until('Environment variables of mybot saved');
    expect(g.paths()).toContain('POST /api/bots/b1/validate-db');
    w.unmount();
    const h = base().on('POST', '/api/bots/b1/validate-db', noAnswer()).on('PUT', ENV, saved());
    const x = await openEditor(h);
    await x.press(TAB, TAB, TAB, RIGHT, TAB, TAB);
    await x.type('z');
    await x.press(...TO_SAVE, ENTER);
    await x.until('The database connection test got no answer from the manager, so whether this URL works is unknown. Save anyway?');
    x.unmount();
  });

  it('a bot with no stored or detected env shows one blank row, and an added row saves', async () => {
    const f = base([]).on('PUT', ENV, saved());
    const v = await openEditor(f);
    await v.type('NEWKEY');
    await v.press(TAB);
    await v.type('v1');
    await v.press(TAB, ENTER);
    await v.until('Environment variables of mybot saved');
    expect(putBody(f)).toEqual([{ vars: { NEWKEY: 'v1' }, removed: [], renamed: {} }]);
    v.unmount();
  });
});

describe('m3 vault picker in the env editor', () => {
  it('lists matching entries once each by key and source, never the value, and the pick is sent masked', async () => {
    const f = base().on('GET', '/api/vault/all-values', vaultValues()).on('PUT', ENV, saved());
    const v = await openEditor(f);
    await v.press(TAB, CTRL('p'));
    await v.until('Pick from the vault for DISCORD_TOKEN');
    const text = flat(v.frame());
    expect(text).toContain('DISCORD_TOKEN Standalone');
    expect(text).not.toContain('Deleted: oldbot');
    expect(text).not.toContain('OTHER_KEY');
    await v.press(ENTER);
    await v.until('*'.repeat(VAULT_TOKEN.length));
    await v.press(...TO_SAVE, ENTER);
    await v.until('Environment variables of mybot saved');
    expect((putBody(f)[0] as { vars: Record<string, string> }).vars.DISCORD_TOKEN).toBe(VAULT_TOKEN);
    expect(v.frames.join('\n')).not.toContain(VAULT_TOKEN);
    expect(v.frames.join('\n')).not.toContain('Other.Secret');
    v.unmount();
  });

  it('with no matching key lists every entry that has a value; Esc closes without a change', async () => {
    const f = base().on('GET', '/api/vault/all-values', vaultValues());
    const v = await openEditor(f);
    await v.press(...TO_SHARDS_VALUE, CTRL('p'));
    await v.until('Pick from the vault for SHARDS');
    const text = flat(v.frame());
    expect(text).toContain('OTHER_KEY Standalone');
    expect(text).not.toContain('EMPTY_KEY');
    await v.press(DOWN, ESC);
    await v.until('[2');
    expect(v.frames.join('\n')).not.toContain('Other.Secret');
    v.unmount();
  });

  it('an empty vault, a refused read and no answer each say so', async () => {
    const f = base().on('GET', '/api/vault/all-values', vaultBody([]));
    const v = await openEditor(f);
    await v.press(TAB, CTRL('p'));
    await v.until('The vault holds no entries to pick from.');
    v.unmount();
    const g = base().on('GET', '/api/vault/all-values', refused(500, { success: false, error: 'vault.json is damaged' }));
    const w = await openEditor(g);
    await w.press(TAB, CTRL('p'));
    await w.until("can't read the vault: vault.json is damaged");
    w.unmount();
    const h = base().on('GET', '/api/vault/all-values', noAnswer());
    const x = await openEditor(h);
    await x.press(TAB, CTRL('p'));
    await x.until("can't read the vault: the manager did not answer (connect ECONNREFUSED 127.0.0.1:8080).");
    x.unmount();
  });

  it('offers no picker on a select, a list or an added row', async () => {
    const f = base().on('GET', '/api/vault/all-values', vaultValues());
    const v = await openEditor(f);
    await v.press(TAB, TAB, TAB);
    expect(keyBar(v.frame())).not.toContain('Ctrl+P');
    await v.press(CTRL('p'), TAB, TAB);
    expect(keyBar(v.frame())).not.toContain('Ctrl+P');
    await v.press(...TO_SAVE, CTRL('n'), TAB);
    expect(keyBar(v.frame())).not.toContain('Ctrl+P');
    await v.press(CTRL('p'));
    expect(f.paths()).not.toContain('GET /api/vault/all-values');
    v.unmount();
  });
});

describe('m3 hidden values', () => {
  it('a stored secret the route never sends, a typed one and a vault pick appear in no frame', async () => {
    const f = base([editorVar({ key: 'DISCORD_TOKEN', displayLabel: 'Discord Bot Token', required: true, sensitive: true, isSet: true }), editorVar({ key: 'API_KEY', sensitive: true, isSet: true })])
      .on('GET', '/api/vault/all-values', vaultValues())
      .on('PUT', ENV, saved());
    const v = await openEditor(f);
    await v.press(TAB);
    await v.type('Hidden.One');
    await v.press(TAB, TAB, CTRL('p'));
    await v.until('Pick from the vault for API_KEY');
    await v.press(ENTER, ...TO_SAVE, ENTER);
    await v.until('Environment variables of mybot saved');
    const all = v.frames.join('\n');
    expect(all).not.toContain('Hidden.One');
    expect(all).not.toContain(VAULT_TOKEN);
    expect(all).not.toContain('Other.Secret');
    expect(putBody(f)[0]).toEqual({ vars: { DISCORD_TOKEN: 'Hidden.One', API_KEY: VAULT_TOKEN }, removed: [], renamed: {} });
    v.unmount();
  });
});


describe('m3 fix 1: a database test the route refuses', () => {
  it('asks with the route error, and saves only after Y', async () => {
    const f = base().on('POST', '/api/bots/b1/validate-db', refused(500, { success: false, error: 'Error: spawn docker ENOENT' })).on('PUT', ENV, saved());
    const v = await openEditor(f);
    await v.press(TAB, TAB, TAB, RIGHT, TAB, TAB);
    await v.type('x');
    await v.press(...TO_SAVE, ENTER);
    await v.until('Database connection test failed: Error: spawn docker ENOENT Save anyway?');
    expect(putBody(f)).toEqual([]);
    expect(v.frames.map(flat).join(' ')).not.toContain('mybot saved');
    await v.press('y');
    await v.until('Environment variables of mybot saved');
    v.unmount();
  });
});
