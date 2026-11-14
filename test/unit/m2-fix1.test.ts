import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import * as ink from 'ink';
import { render } from 'ink-testing-library';
import { createApp } from '../../src/cli/tui/app';
import { Session } from '../../src/cli/tui/session';
import { parseConfig, serializeConfig, ConfigOp } from '../../src/config/configSerializer';
import {
  botList, configSaved, created, envSaved, envVar, fake, Fake, gitSource, NAME_PATH, nameOk, noAnswer, ok, RECOVER_PATH, refused, repoEnvs,
  sourceList,
} from './m2-fake';

const App = createApp(ink);
vi.setConfig({ testTimeout: 20_000 });
const ESC = '\u001B';
const ENTER = '\r';
const TAB = '\t';
const CTRL = (c: string) => String.fromCharCode(c.charCodeAt(0) - 96);
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const flat = (frame: string) => frame.split('\n').map((l) => l.replace(/^\| /, '').replace(/\s*\|$/, '').trim()).join(' ').replace(/\s+/g, ' ');
const tabs = (n: number) => Array(n).fill(TAB);
const keyBar = (frame: string) => frame.split('\n').at(-2) ?? '';

// Fields copied from open-ticket's general.jsonc manifest (src/config/installManifests.ts:267).
const j = (path: string) => ({ kind: 'json', path });
const MANIFEST = {
  match: { urlContains: 'coolbot' },
  target: 'general.jsonc',
  format: 'json',
  sections: [{
    id: 'identity',
    title: 'Identity & Connection',
    fields: [
      { type: 'password', label: 'Bot Token', required: true, sensitive: true, placeholders: ['INSERT_BOT_TOKEN'], envAlt: { var: 'TOKEN', flagPath: 'tokenFromENV' }, target: j('token') },
      { type: 'guild-id', label: 'Server (Guild) ID', required: true, placeholders: ['DISCORD_SERVER_ID'], target: j('serverId') },
      { type: 'list', label: 'Global Admins', default: [], target: j('globalAdmins'), element: { field: { type: 'role-or-user-id', label: 'Role or User', placeholders: ['DISCORD_ROLE_ID'], serverIdRef: { kind: 'json', path: 'serverId' } } } },
      { type: 'text', label: 'Text Command Prefix', default: '!ticket ', target: j('prefix') },
    ],
  }],
};
const BODY = `{
  "token": "MTIz.abc.def",
  "tokenFromENV": false,
  "serverId": "123456789012345678",
  "globalAdmins": ["111111111111111111", "222222222222222222"],
  "prefix": "!ticket "
}
`;

interface Serialized { format: 'json' | 'yaml'; body: string; ops: ConfigOp[] }

function base(): Fake {
  return fake()
    .on('GET', '/api/bots', botList([]))
    .on('GET', '/api/sources', sourceList([gitSource()]))
    .on('GET', '/api/sources/s1/envs', repoEnvs({
      vars: [envVar({ key: 'CLIENT_ID', displayLabel: 'Discord Client ID' })],
      configFiles: [{ inContainerPath: '/app/config/general.jsonc', targetName: 'general.jsonc', format: 'json', rawBody: BODY, keys: [], manifest: MANIFEST, parsed: (parseConfig('json', BODY) as { data: unknown }).data }],
    }))
    .on('GET', NAME_PATH('coolbot'), nameOk('coolbot'))
    .on('POST', '/api/config/serialize', (b) => {
      const { format, body, ops } = b as Serialized;
      return ok({ success: true, ...serializeConfig(format, body, ops) });
    })
    .on('POST', '/api/config/parse', (b) => ok({ success: true, ...parseConfig('json', (b as Serialized).body) }))
    // validateDiscordId's answers (src/discord/validator.ts): the first admin is a user, the second no user or role.
    .on('POST', '/api/discord/validate', (b) => {
      const { id } = b as { id: string };
      if (id === '111111111111111111') return ok({ success: true, status: 'ok', name: 'Alice', resolvedKind: 'user' });
      if (id === '222222222222222222') return ok({ success: true, status: 'invalid' });
      return ok({ success: true, status: 'ok', name: 'Acme HQ', resolvedKind: 'guild' });
    })
    .on('POST', '/api/bots', created())
    .on('PUT', '/api/bots/b9/env', envSaved())
    .on('PUT', '/api/bots/b9/config', configSaved());
}

async function openForm(f: Fake, rows = 90) {
  const session = new Session(f.client, () => 0);
  await session.refresh();
  const view = render(createElement(App, { machine: 'box1', session, onHandOff: vi.fn(), now: () => 0 }));
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
  await press('i');
  await until('coolbot');
  await press(ENTER);
  await until('Install from Source: coolbot');
  return { ...view, frame, press, until };
}

// From the name field: CLIENT_ID key and value, the file, token, server, admins, admin 0, admin 1, prefix, Install.
const AT = { token: 4, admins: 6, admin0: 7, prefix: 9, install: 10 };
const posts = (f: Fake) => f.paths().filter((p) => p === 'POST /api/bots').length;

function slowSerialize(f: Fake): Fake {
  return f.on('POST', '/api/config/serialize', async (b) => {
    await tick(400);
    const { format, body, ops } = b as Serialized;
    return ok({ success: true, ...serializeConfig(format, body, ops) });
  });
}

describe('m2 fix 1: one install at a time', () => {
  it('a second Enter while the form changes are still being written creates no second bot', async () => {
    const f = slowSerialize(base());
    const v = await openForm(f);
    await v.press(...tabs(AT.prefix), '?', ...tabs(5), ENTER, ENTER, ENTER);
    await v.until('Bot instance coolbot (b9) created.');
    await tick(600);
    expect(posts(f)).toBe(1);
    v.unmount();
  });

  it("Esc while the changes are being written closes the form, and the install stops with the page's text", async () => {
    const f = slowSerialize(base());
    const v = await openForm(f);
    await v.press(...tabs(AT.prefix), '?', ...tabs(5), ENTER, ESC);
    await v.until('The install form was closed before installing. Nothing was created.');
    await tick(600);
    expect(posts(f)).toBe(0);
    v.unmount();
  });
});

describe('m2 fix 1b: an install left behind by Esc', () => {
  const CLOSED = 'The install form was closed before installing. Nothing was created.';

  it('does not hold up or write into the form opened after it', async () => {
    const f = base().on('POST', '/api/config/serialize', async (b) => {
      await tick(1500);
      const { format, body, ops } = b as Serialized;
      return ok({ success: true, ...serializeConfig(format, body, ops) });
    });
    const v = await openForm(f);
    await v.press(...tabs(AT.prefix), '?', ...tabs(5), ENTER, ESC);
    await v.until('Sources');
    await v.press(ENTER);
    await v.until('Install from Source: coolbot');
    await v.press('x');
    expect(v.frame()).toMatch(/Name\s+\[coolbotx/);
    await v.press(...tabs(AT.install + 3), ENTER);
    await v.until('Bot instance coolbotx (b9) created.');
    await tick(1600);
    expect(posts(f)).toBe(1);
    expect(v.frames.map(flat).join(' ')).not.toContain(CLOSED);
    v.unmount();
  });

  it('still says the form was closed when the screen is left on Sources', async () => {
    const f = slowSerialize(base());
    const v = await openForm(f);
    await v.press(...tabs(AT.prefix), '?', ...tabs(5), ENTER, ESC);
    await v.until('Sources');
    await v.until(CLOSED);
    await tick(600);
    expect(posts(f)).toBe(0);
    v.unmount();
  });
});

describe('m2 fix 1: a reply that is not JSON', () => {
  it("says can't confirm the bot was created, as the page does", async () => {
    const f = base().on('POST', '/api/bots', refused(502, '<html><body>502 Bad Gateway</body></html>'));
    const v = await openForm(f);
    await v.press(...tabs(AT.install + 3), ENTER);
    await v.until("can't confirm the bot was created: the manager did not answer (the reply was not JSON, HTTP 502).");
    v.unmount();
  });
});

describe('m2 fix 1: list checks follow their item', () => {
  it('a removed item takes its check with it; the shifted item shows its own', async () => {
    const f = base();
    const v = await openForm(f);
    await v.until('Discord: Alice');
    await v.until('Discord: Invalid ID');
    await v.press(...tabs(AT.admin0), CTRL('d'));
    await tick(100);
    await v.until('Global Admins (1)');
    expect(flat(v.frame())).not.toContain('Discord: Alice');
    expect(flat(v.frame())).toContain('Discord: Invalid ID');
    v.unmount();
  });
});

describe('m2 fix 1: Ctrl+E keeps a typed value', () => {
  it('writes the typed token before the switch, and the switch back restores it', async () => {
    const f = base();
    const v = await openForm(f);
    await v.press(...tabs(AT.token), 'X', CTRL('e'));
    await tick(100);
    await v.press(CTRL('e'));
    await tick(100);
    const ops = f.calls.filter((c) => c.path === '/api/config/serialize').flatMap((c) => (c.body as Serialized).ops);
    expect(ops).toEqual([
      { path: 'token', value: 'MTIz.abc.defX' },
      { path: 'tokenFromENV', value: true },
      { path: 'token', value: '' },
      { path: 'tokenFromENV', value: false },
      { path: 'token', value: 'MTIz.abc.defX' },
    ]);
    v.unmount();
  });
});

describe('m2 fix 1: key bar', () => {
  it('names Up as the previous field on the Install line', async () => {
    const v = await openForm(base());
    await v.press(...tabs(AT.install + 3));
    expect(keyBar(v.frame())).toMatch(/^\| Enter Install {2}Up Previous {2}Esc Back\s+\|$/);
    v.unmount();
  });
});

describe('m2 fix 1: Load envs and scan answers', () => {
  const offer = (f: Fake) => f.on('GET', NAME_PATH('coolbot'), nameOk('coolbot', { envsAvailable: true }));
  // GET /api/recover-envs (bots.ts:2439).
  const answers: Array<[string, unknown, string]> = [
    ['refused', refused(500, { success: false, error: 'Error: vault.json is locked', envs: [] }), 'Error: vault.json is locked'],
    ['no answer', noAnswer(), "can't confirm the earlier envs: the manager did not answer (connect ECONNREFUSED 127.0.0.1:8080)."],
    ['empty', ok({ success: true, name: 'coolbot', envs: [], sources: { vault: 0, compose: 0 }, vaultBroken: false }), 'No recoverable envs found for this name.'],
    ['vault broken', ok({ success: true, name: 'coolbot', envs: [], sources: { vault: 0, compose: 0 }, vaultBroken: true }), 'vault.json cannot be read, so envs kept from a removed bot could not be checked. Repair vault.json and try again.'],
  ];
  for (const [name, answer, text] of answers) {
    it(`Load envs: ${name}`, async () => {
      const f = offer(base()).on('GET', RECOVER_PATH('coolbot'), answer as never);
      const v = await openForm(f);
      await v.until('Envs from an earlier install are available.');
      await v.press(CTRL('l'));
      await v.until(text);
      v.unmount();
    });
  }

  it('says the scan failed with the route error', async () => {
    const f = base().on('GET', '/api/sources/s1/envs?scan=true', refused(500, { success: false, error: 'Error: EACCES: permission denied' }));
    const v = await openForm(f);
    await v.press(TAB, CTRL('f'));
    await v.until('Scan failed: Error: EACCES: permission denied');
    v.unmount();
  });
});
