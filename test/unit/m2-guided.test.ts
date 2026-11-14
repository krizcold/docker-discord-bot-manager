import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import * as ink from 'ink';
import { render } from 'ink-testing-library';
import { createApp } from '../../src/cli/tui/app';
import { Session } from '../../src/cli/tui/session';
import { parseConfig, serializeConfig, ConfigOp } from '../../src/config/configSerializer';
import {
  botList, configSaved, created, envSaved, envVar, fake, Fake, gitSource, NAME_PATH, nameOk, noAnswer, ok, refused, repoEnvs, sourceList,
} from './m2-fake';

const App = createApp(ink);
// Each row types key by key with a 30 ms pause; the longest take about 5 s beside other files.
vi.setConfig({ testTimeout: 20_000 });
const ESC = '\u001B';
const ENTER = '\r';
const TAB = '\t';
const RIGHT = '\u001B[C';
const BACKSPACE = '\u007F';
const CTRL = (c: string) => String.fromCharCode(c.charCodeAt(0) - 96);
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const flat = (frame: string) => frame.split('\n').map((l) => l.replace(/^\| /, '').replace(/\s*\|$/, '').trim()).join(' ').replace(/\s+/g, ' ');

// Field descriptors copied from open-ticket's general.jsonc manifest (src/config/installManifests.ts:267), cut to one
// field of each kind, plus an object list, as GET /api/sources/:id/envs attaches it.
const j = (path: string) => ({ kind: 'json', path });
const MANIFEST = {
  match: { urlContains: 'coolbot' },
  target: 'general.jsonc',
  format: 'json',
  sections: [
    {
      id: 'identity',
      title: 'Identity & Connection',
      fields: [
        { type: 'password', label: 'Bot Token', required: true, sensitive: true, isBotToken: true, placeholders: ['INSERT_BOT_TOKEN'], envAlt: { var: 'TOKEN', flagPath: 'tokenFromENV' }, target: j('token') },
        { type: 'guild-id', label: 'Server (Guild) ID', required: true, placeholders: ['DISCORD_SERVER_ID'], target: j('serverId') },
        { type: 'list', label: 'Global Admins', default: [], target: j('globalAdmins'), element: { field: { type: 'role-or-user-id', label: 'Role or User', placeholders: ['DISCORD_ROLE_ID'], serverIdRef: { kind: 'json', path: 'serverId' } } } },
        { type: 'color', label: 'Main Color', default: '#f8ba00', target: j('mainColor') },
        { type: 'select', label: 'Language', default: 'english', options: [{ value: 'english' }, { value: 'dutch' }], target: j('language') },
        { type: 'text', label: 'Text Command Prefix', default: '!ticket ', target: j('prefix') },
        { type: 'boolean', label: 'Enable Slash Commands', default: true, target: j('slashCommands') },
        { type: 'number', label: 'Global Maximum', default: 50, target: j('limits.globalMaximum') },
        { type: 'list', label: 'Categories', target: j('categories'), element: { itemLabel: 'Category {name}', objectFields: [{ key: 'name', type: 'text', label: 'Name' }, { key: 'role', type: 'role-id', label: 'Role', serverIdRef: { kind: 'json', path: 'serverId' } }] } },
      ],
    },
    {
      id: 'logs',
      title: 'Logs',
      toggle: { target: j('logs.enabled'), default: false, disabledBehavior: 'set-false' },
      fields: [
        { type: 'channel-id', label: 'Log Channel', placeholders: ['DISCORD_CHANNEL_ID'], serverIdRef: { kind: 'json', path: 'serverId' }, target: j('logs.channel') },
        { type: 'grid', label: 'Log messages', target: j('logs.logMessages'), rows: [{ key: 'created', label: 'Created' }, { key: 'closed', label: 'Closed' }], columns: [{ key: 'dm', label: 'DM user' }, { key: 'logs', label: 'Log channel' }] },
      ],
    },
  ],
};

const BODY = `{
  // the bot's token
  "token": "INSERT_BOT_TOKEN",
  "tokenFromENV": false,
  "serverId": "DISCORD_SERVER_ID",
  "globalAdmins": [],
  "mainColor": "#f8ba00",
  "language": "english",
  "prefix": "!ticket ",
  "slashCommands": true,
  "limits": { "globalMaximum": 50 },
  "categories": [],
  "logs": {
    "enabled": false,
    "channel": "DISCORD_CHANNEL_ID",
    "logMessages": { "created": { "dm": false, "logs": true }, "closed": { "dm": false, "logs": true } }
  }
}
`;

const parsedBody = () => (parseConfig('json', BODY) as { data: unknown }).data;

function guidedEnvs() {
  return repoEnvs({
    vars: [envVar({ key: 'CLIENT_ID', displayLabel: 'Discord Client ID' })],
    configFiles: [{ inContainerPath: '/app/config/general.jsonc', targetName: 'general.jsonc', format: 'json', rawBody: BODY, keys: [], manifest: MANIFEST, parsed: parsedBody() }],
  });
}

interface Serialized { format: 'json' | 'yaml'; body: string; ops: ConfigOp[] }

// POST /api/config/serialize and /api/config/parse (src/webui/routes/config.ts:18, :33) answered by the real serializer.
function base(): Fake {
  return fake()
    .on('GET', '/api/bots', botList([]))
    .on('GET', '/api/sources', sourceList([gitSource()]))
    .on('GET', '/api/sources/s1/envs', guidedEnvs())
    .on('GET', NAME_PATH('coolbot'), nameOk('coolbot'))
    .on('POST', '/api/config/serialize', (b) => {
      const { format, body, ops } = b as Serialized;
      return ok({ success: true, ...serializeConfig(format, body, ops) });
    })
    .on('POST', '/api/config/parse', (b) => {
      const { format, body } = b as Serialized;
      return ok({ success: true, ...parseConfig(format, body) });
    })
    .on('POST', '/api/bots', created())
    .on('PUT', '/api/bots/b9/env', envSaved())
    .on('PUT', '/api/bots/b9/config', configSaved());
}

async function openForm(f: Fake) {
  const session = new Session(f.client, () => 0);
  await session.refresh();
  const view = render(createElement(App, { machine: 'box1', session, onHandOff: vi.fn(), now: () => 0, wizardOptions: { secret: () => 'x'.repeat(64) } }));
  (view.stdout as unknown as { rows: number }).rows = 90;
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
  await press('i');
  await until('coolbot');
  await press(ENTER);
  await until('Identity & Connection');
  return { ...view, frame, press, until };
}

// Tabs from the name field: CLIENT_ID key and value, the file line, its path, Writable and body, then the form in order.
const AT = { token: 7, serverId: 8, admins: 9, color: 10, language: 11, prefix: 12, slash: 13, maximum: 14, categories: 15, logs: 16 };
const tabs = (n: number) => Array(n).fill(TAB);
const serializeCalls = (f: Fake) => f.calls.filter((c) => c.path === '/api/config/serialize').map((c) => c.body as Serialized);
const keyBar = (frame: string) => frame.split('\n').at(-2) ?? '';
const installs = (f: Fake) => f.paths().filter((p) => p === 'POST /api/bots');

describe('m2 guided form', () => {
  it('shows each field kind from the manifest with its value, default and required mark, and checks no placeholder id', async () => {
    const f = base();
    const v = await openForm(f);
    const t = flat(v.frame());
    expect(t).toContain('Bot Token (required) (In file)');
    expect(t).toContain(`[${'*'.repeat(16)}`);
    expect(v.frames.join('\n')).not.toContain('INSERT_BOT_TOKEN');
    expect(t).toContain('Server (Guild) ID (required) [DISCORD_SERVER_ID');
    expect(t).toContain('Global Admins (0) None yet');
    expect(t).toContain('Main Color [#f8ba00');
    expect(t).toContain('Language < english >');
    expect(t).toContain('Text Command Prefix [!ticket');
    expect(t).toContain('[x] Enable Slash Commands');
    expect(t).toContain('Global Maximum [50');
    expect(t).toContain('Categories (0)');
    expect(t).toContain('[ ] Logs');
    expect(t).not.toContain('Log Channel');
    expect(f.paths()).not.toContain('POST /api/discord/validate');
    v.unmount();
  });

  it('writes a typed text through the serialize round trip when the cursor leaves, and Install sends that body', async () => {
    const f = base();
    const v = await openForm(f);
    await v.press(...tabs(AT.prefix), '?');
    expect(serializeCalls(f)).toEqual([]);
    await v.press(TAB);
    await tick(60);
    expect(serializeCalls(f)).toEqual([{ format: 'json', body: BODY, ops: [{ path: 'prefix', value: '!ticket ?' }] }]);
    await v.press(...tabs(30), ENTER);
    await v.until('Bot instance coolbot (b9) created.');
    const put = f.calls.find((c) => c.path === '/api/bots/b9/config')!.body as { files: Array<{ body: string }> };
    expect(put.files[0].body).toContain('"prefix": "!ticket ?"');
    expect(put.files[0].body).toContain("// the bot's token");
    v.unmount();
  });

  it('changes a select, a boolean, a section toggle and grid cells at once, and keeps a bad number out of the file', async () => {
    const f = base();
    const v = await openForm(f);
    await v.press(...tabs(AT.language), RIGHT);
    await tick(60);
    expect(v.frame()).toContain('< dutch >');
    await v.press(TAB, TAB, ' ');
    await tick(60);
    expect(v.frame()).toContain('[ ] Enable Slash Commands');
    await v.press(TAB, 'x', TAB);
    await tick(60);
    await v.until('Not a number: the file keeps 50');
    await v.press(TAB, ' ');
    await tick(60);
    await v.until('Log Channel');
    await v.press(TAB, TAB, ' ');
    await tick(60);
    await v.press(CTRL('a'));
    await tick(60);
    const ops = serializeCalls(f).flatMap((c) => c.ops);
    expect(ops).toEqual([
      { path: 'language', value: 'dutch' },
      { path: 'slashCommands', value: false },
      { path: 'logs.enabled', value: true },
      { path: 'logs.logMessages.created.dm', value: true },
      { path: 'logs.logMessages.created.dm', value: true },
      { path: 'logs.logMessages.closed.dm', value: true },
    ]);
    expect(ops.some((o) => o.path === 'limits.globalMaximum')).toBe(false);
    v.unmount();
  });

  it('adds and removes list items with their own ops, as the page does', async () => {
    const f = base();
    const v = await openForm(f);
    await v.press(...tabs(AT.admins), CTRL('n'));
    await tick(60);
    expect(v.frame()).toMatch(/Global Admins\s+\(1\)/);
    await v.press(TAB, CTRL('d'));
    await tick(60);
    expect(v.frame()).toMatch(/Global Admins\s+\(0\)/);
    await v.press(...tabs(AT.categories - AT.admins), CTRL('n'));
    await tick(60);
    await v.until('Categories (1)');
    await v.press(TAB, TAB, 'Support', TAB);
    await tick(60);
    await v.until('Category Support');
    const ops = serializeCalls(f).flatMap((c) => c.ops);
    expect(ops).toEqual([
      { path: 'globalAdmins[0]', value: '', insert: true },
      { path: 'globalAdmins[0]', remove: true },
      { path: 'categories[0]', value: { name: '', role: '' }, insert: true },
      { path: 'categories[0].name', value: 'Support' },
    ]);
    v.unmount();
  });
});

describe('m2 guided round trips', () => {
  it('shows a refused or unanswered serialize on the file and refuses Install with the page reason', async () => {
    const f = base().on('POST', '/api/config/serialize', refused(500, { success: false, error: 'Internal error' }));
    const v = await openForm(f);
    await v.press(...tabs(AT.prefix), '?', TAB);
    await v.until('A form change was not written to the file: Internal error');
    await v.press(...tabs(30), ENTER);
    await v.until('A form change could not be written into its file (see the warning on the file). Nothing was saved.');
    expect(installs(f)).toEqual([]);
    expect(serializeCalls(f).length).toBe(2);
    f.on('POST', '/api/config/serialize', noAnswer());
    await v.press(ENTER);
    await v.until('A form change was not written to the file: the manager did not answer (connect ECONNREFUSED 127.0.0.1:8080)');
    expect(installs(f)).toEqual([]);
    v.unmount();
  });

  it('parses the body again after a skipped op, says the change was not applied and refuses Install', async () => {
    const f = base().on('POST', '/api/config/serialize', (b) => ok({ success: true, body: (b as Serialized).body, skipped: ['prefix'] }));
    const v = await openForm(f);
    await v.press(...tabs(AT.prefix), '?', TAB);
    await v.until('Could not apply: prefix; the file was not changed there');
    await v.until('This change could not be written to the file.');
    expect(f.paths()).toContain('POST /api/config/parse');
    await v.press(...tabs(30), ENTER);
    await v.until('A form change could not be written into its file');
    expect(installs(f)).toEqual([]);
    v.unmount();
  });

  const parseFailures: Array<[string, unknown, string]> = [
    ['the body does not parse', ok({ success: true, ok: false, error: 'PropertyNameExpected at offset 3' }), 'The file does not parse, so its guided form is paused'],
    ['no answer', noAnswer(), 'Could not refresh the form; showing earlier values'],
  ];
  for (const [name, answer, text] of parseFailures) {
    it(`keeps the form and says so when the parse fails: ${name}`, async () => {
      let skip = true;
      const f = base()
        .on('POST', '/api/config/serialize', (b) => {
          const { format, body, ops } = b as Serialized;
          return ok({ success: true, ...(skip ? { body, skipped: ['prefix'] } : serializeConfig(format, body, ops)) });
        })
        .on('POST', '/api/config/parse', answer as never);
      const v = await openForm(f);
      await v.press(...tabs(AT.prefix), '?', TAB);
      await v.until('Could not apply: prefix');
      skip = false;
      await v.press('\u001B[A', '!', TAB);
      await v.until(text);
      expect(v.frame()).toContain('Text Command Prefix');
      v.unmount();
    });
  }
});

describe('m2 erasure confirm', () => {
  async function toEnv(f: Fake) {
    const v = await openForm(f);
    await v.press(...tabs(AT.token), CTRL('e'));
    await tick(60);
    await v.until('Bot Token (From env) Set TOKEN as an environment variable for this bot.');
    expect(serializeCalls(f).flatMap((c) => c.ops)).toEqual([{ path: 'tokenFromENV', value: true }, { path: 'token', value: '' }]);
    await v.press(...tabs(30), ENTER);
    await v.until('Saving clears the value stored in the file for: Bot Token (now read from TOKEN). Continue?');
    expect(keyBar(v.frame())).toContain('Y Continue');
    return v;
  }

  it('asks before Install clears an in-file value, and another key cancels with nothing sent', async () => {
    const f = base();
    const v = await toEnv(f);
    await v.press('n');
    await v.until('Cancelled: nothing was created.');
    expect(installs(f)).toEqual([]);
    v.unmount();
  });

  it('Y goes on with the install', async () => {
    const f = base();
    const v = await toEnv(f);
    await v.press('y');
    await v.until('Bot instance coolbot (b9) created.');
    const put = f.calls.find((c) => c.path === '/api/bots/b9/config')!.body as { files: Array<{ body: string }> };
    expect(put.files[0].body).toContain('"tokenFromENV": true');
    expect(put.files[0].body).toContain('"token": ""');
    v.unmount();
  });
});

describe('m2 Discord checks', () => {
  const TOKEN = 'MTIzNDU2.Gx-real.secret_token_value';

  async function withToken(f: Fake) {
    const v = await openForm(f);
    await v.press(...tabs(AT.token), ...Array(16).fill(BACKSPACE), TOKEN, TAB);
    await tick(60);
    return v;
  }

  // POST /api/discord/validate (src/webui/routes/discord.ts:15) with validateDiscordId's results (src/discord/validator.ts).
  const answers: Array<[string, unknown, string]> = [
    ['valid', ok({ success: true, status: 'ok', name: 'Acme HQ', avatarUrl: null, resolvedKind: 'guild' }), 'Discord: Acme HQ'],
    ['not in the server', ok({ success: true, status: 'bot_not_in_guild' }), 'Discord: Bot not in this server, or it cannot read it'],
    ['token rejected', ok({ success: true, status: 'cannot_validate', reason: 'token_rejected' }), 'Discord: Discord rejected this token (401): check or regenerate it'],
    ['no answer', noAnswer(), "Discord: can't confirm: the manager did not answer (connect ECONNREFUSED 127.0.0.1:8080)"],
  ];

  for (const [name, answer, text] of answers) {
    it(`checks a server id when the cursor leaves it: ${name}`, async () => {
      const f = base().on('POST', '/api/discord/validate', answer as never);
      const v = await withToken(f);
      await v.press(...Array(17).fill(BACKSPACE), '123456789012345678', TAB);
      await v.until(text);
      const call = f.calls.find((c) => c.path === '/api/discord/validate')!;
      expect(call.body).toEqual({ token: TOKEN, kind: 'guild', id: '123456789012345678' });
      expect(v.frames.join('\n')).not.toContain(TOKEN);
      expect(v.frames.join('\n')).not.toContain('secret_token');
      v.unmount();
    });
  }

  it('says an id is invalid as the route answers, and checks the format before any call', async () => {
    const f = base().on('POST', '/api/discord/validate', (b) => {
      const { kind } = b as { kind: string };
      return ok(kind === 'channel' ? { success: true, status: 'invalid' } : { success: true, status: 'ok', name: 'Acme HQ', resolvedKind: 'guild' });
    });
    const v = await withToken(f);
    await v.press(...Array(17).fill(BACKSPACE), 'abc', TAB);
    await v.until('Discord: Invalid guild');
    expect(f.paths()).not.toContain('POST /api/discord/validate');
    await v.press(ESC);
    const w = await withToken(f);
    await w.press(...Array(17).fill(BACKSPACE), '123456789012345678', TAB);
    await w.until('Discord: Acme HQ');
    await w.press(...tabs(AT.logs - AT.serverId - 1), ' ');
    await tick(60);
    await w.press(TAB, ...Array(18).fill(BACKSPACE), '223456789012345678', TAB);
    await w.until('Discord: Invalid channel');
    const channel = f.calls.filter((c) => c.path === '/api/discord/validate').at(-1)!.body;
    expect(channel).toEqual({ token: TOKEN, kind: 'channel', id: '223456789012345678', guildId: '123456789012345678' });
    v.unmount();
    w.unmount();
  });
});
