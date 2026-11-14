import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import * as ink from 'ink';
import { render } from 'ink-testing-library';
import { createApp } from '../../src/cli/tui/app';
import { Session } from '../../src/cli/tui/session';
import {
  botList, configSaved, created, envSaved, envVar, fake, Fake, freshSource, gitSource, imageSource, NAME_PATH, nameOk, repoEnvs, sourceList,
} from './m2-fake';
import { VAULT_TOKEN, vaultValues } from './m3-fake';

const App = createApp(ink);
vi.setConfig({ testTimeout: 20_000 });
const ESC = '\u001B';
const ENTER = '\r';
const TAB = '\t';
const DOWN = '\u001B[B';
const CTRL = (c: string) => String.fromCharCode(c.charCodeAt(0) - 96);

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const flat = (frame: string) => frame.split('\n').map((l) => l.replace(/^\| /, '').replace(/\s*\|$/, '').trim()).join(' ').replace(/\s+/g, ' ');
const keyBar = (frame: string) => frame.split('\n').at(-2) ?? '';

function base(): Fake {
  return fake()
    .on('GET', '/api/bots', botList([]))
    .on('GET', '/api/sources', sourceList([gitSource(), freshSource(), imageSource()]))
    .on('GET', '/api/sources/s1/envs', repoEnvs())
    .on('GET', NAME_PATH('coolbot'), nameOk('coolbot'))
    .on('GET', '/api/vault/all-values', vaultValues())
    .on('POST', '/api/bots', created())
    .on('PUT', '/api/bots/b9/env', envSaved())
    .on('PUT', '/api/bots/b9/config', configSaved());
}

async function openForm(f: Fake) {
  const session = new Session(f.client, () => 0);
  await session.refresh();
  const view = render(createElement(App, { machine: 'box1', session, onHandOff: vi.fn(), now: () => 0, wizardOptions: { now: () => 0 } }));
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
  await until('Compose name: coolbot');
  return { ...view, frame, press, until };
}

const envPut = (f: Fake) => f.calls.find((c) => c.method === 'PUT' && c.path === '/api/bots/b9/env')?.body as { vars: Record<string, string> } | undefined;

describe('m3 vault picker in the install form', () => {
  it('Ctrl+P on the token value lists the matching entry, and the pick is installed, never shown', async () => {
    const f = base();
    const v = await openForm(f);
    await v.press(TAB, TAB);
    expect(keyBar(v.frame())).toContain('Ctrl+P Vault');
    await v.press(CTRL('p'));
    await v.until('Pick from the vault for DISCORD_TOKEN');
    expect(flat(v.frame())).toContain('DISCORD_TOKEN Standalone');
    expect(flat(v.frame())).not.toContain('OTHER_KEY');
    await v.press(ENTER);
    await v.until('*'.repeat(VAULT_TOKEN.length));
    await v.press(...Array(8).fill(TAB), ENTER);
    await v.until('Bot instance coolbot (b9) created');
    expect(envPut(f)?.vars.DISCORD_TOKEN).toBe(VAULT_TOKEN);
    expect(v.frames.join('\n')).not.toContain(VAULT_TOKEN);
    v.unmount();
  });

  it('a row with no matching key lists every entry with a value; Esc keeps the row as it was', async () => {
    const f = base();
    const v = await openForm(f);
    await v.press(TAB, TAB, TAB, TAB, CTRL('p'));
    await v.until('Pick from the vault for CLIENT_ID');
    expect(flat(v.frame())).toContain('OTHER_KEY Standalone');
    expect(flat(v.frame())).not.toContain('EMPTY_KEY');
    await v.press(DOWN, ESC);
    await v.until('Install from Source: coolbot');
    await v.press(...Array(8).fill(DOWN), ENTER);
    await v.until('Bot instance coolbot (b9) created');
    expect(envPut(f)).toBeUndefined();
    expect(v.frames.join('\n')).not.toContain('Other.Secret');
    v.unmount();
  });

  it('offers no picker on a key, an added row, a recovered or scanned row', async () => {
    const f = base().on('GET', '/api/sources/s1/envs', repoEnvs({ vars: [envVar({ key: 'MODE', options: [{ value: 'a' }, { value: 'b' }] })] }));
    const v = await openForm(f);
    await v.press(TAB);
    expect(keyBar(v.frame())).not.toContain('Ctrl+P');
    await v.press(TAB);
    expect(keyBar(v.frame())).not.toContain('Ctrl+P');
    await v.press(CTRL('n'), TAB);
    expect(keyBar(v.frame())).not.toContain('Ctrl+P');
    await v.press(CTRL('p'));
    expect(f.paths()).not.toContain('GET /api/vault/all-values');
    v.unmount();
  });
});
