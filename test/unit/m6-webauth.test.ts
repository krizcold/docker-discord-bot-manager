import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import * as ink from 'ink';
import { render } from 'ink-testing-library';
import { createApp } from '../../src/cli/tui/app';
import { Session } from '../../src/cli/tui/session';
import { WEB_AUTH_NO_ANSWER, WEB_AUTH_SAVED } from '../../src/cli/tui/webauth';
import { fake, Fake, noAnswer, ok, refused, Reply } from './m2-fake';
import { botRow } from './m3-fake';

const App = createApp(ink);
vi.setConfig({ testTimeout: 30_000 });
const ESC = '\u001B';
const ENTER = '\r';
const UP = '\u001B[A';
const DOWN = '\u001B[B';
const WAIT_MS = 10_000;
const PUT = '/api/bots/b1/web-auth';

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const flat = (frame: string) => frame.split('\n').map((l) => l.replace(/^\| /, '').replace(/\s*\|$/, '').trim()).join(' ').replace(/\s+/g, ' ');
const keyBar = (frame: string) => frame.split('\n').slice(-3, -1).map((l) => l.replace(/^\| /, '').replace(/\s*\|$/, '').trim()).join('  ');

// GET /api/bots (bots.ts:242); publicUrl and webAuth are the instance's (src/types/index.ts:347, :349).
const listOf = (bots: unknown[]) => ok({ success: true, bots, deploymentMode: 'docker', portBind: { bind: '127.0.0.1', loopback: true } });
const URL_BOT = { publicUrl: 'https://mybot.example.org', webAuth: 'managed' };
// PUT web-auth success (bots.ts:2314): publicBot of the updated instance.
const saved = (mode: string) => ok({ success: true, bot: botRow({ ...URL_BOT, webAuth: mode }) });

function later() {
  let answer: (r: Reply) => void = () => {};
  const p = new Promise<Reply>((resolve) => {
    answer = resolve;
  });
  return { reply: () => p, answer: (r: Reply) => answer(r) };
}

function manager(bot: Record<string, unknown> = URL_BOT) {
  const state = { bots: [botRow({ status: 'running', ...bot })] };
  const f = fake().on('GET', '/api/bots', () => listOf(state.bots));
  return { f, state };
}

async function start(f: Fake, opts: { columns?: number } = {}) {
  const session = new Session(f.client, () => 0);
  await session.refresh();
  const view = render(createElement(App, { machine: 'box1', session, onHandOff: vi.fn(), now: () => 0 }));
  const stdout = view.stdout as unknown as { rows: number };
  stdout.rows = 30;
  Object.defineProperty(view.stdout, 'columns', { value: opts.columns ?? 100, configurable: true });
  view.stdout.emit('resize');
  await tick();
  const frame = () => view.lastFrame() ?? '';
  const press = async (...keys: string[]) => {
    for (const k of keys) {
      view.stdin.write(k);
      await tick();
    }
  };
  const until = async (test: () => boolean, what: string) => {
    const end = Date.now() + WAIT_MS;
    while (!test() && Date.now() < end) await tick(20);
    expect(test(), what).toBe(true);
  };
  const untilText = (text: string) => until(() => flat(frame()).includes(text), text);
  const puts = () => f.calls.filter((c) => c.method === 'PUT' && c.path === PUT).map((c) => c.body);
  return { ...view, session, frame, press, until, untilText, puts };
}

async function openPicker(f: Fake, opts: Parameters<typeof start>[1] = {}) {
  const v = await start(f, opts);
  await v.press(ENTER);
  await v.untilText('Name mybot');
  await v.press('w');
  await v.untilText('Web login of mybot');
  return v;
}

describe('m6 web login: the picker', () => {
  it('W is offered only with a public URL (index.html:1669)', async () => {
    const v = await start(manager({}).f);
    await v.press(ENTER);
    await v.untilText('Name mybot');
    expect(keyBar(v.frame())).not.toContain('W Web login');
    await v.press('w');
    await v.untilText('mybot has no public URL, so it has no web login to set.');
    v.unmount();
  });

  it('the picker marks the mode of the list read, with the select title under it', async () => {
    const v = await openPicker(manager().f);
    const text = flat(v.frame());
    expect(text).toContain('> Managed (current)');
    expect(text).toContain('Auto');
    expect(text).toContain('Public');
    expect(text).toContain("Public URL access: Auto detects self-authenticating bots, Managed puts the bot behind the stack's Authelia SSO login (optional MFA), Public disables auth. Applies on the bot's next Update or Build.");
    expect(keyBar(v.frame())).not.toContain('Enter Change');
    await v.press(ENTER);
    await tick(100);
    expect(v.puts()).toEqual([]);
    v.unmount();
  });

  it('a bot with no webAuth shows Auto as the page does (index.html:1668)', async () => {
    const v = await openPicker(manager({ publicUrl: 'https://mybot.example.org' }).f);
    expect(flat(v.frame())).toContain('> Auto (current)');
    v.unmount();
  });

  it('the mark follows the newest list read', async () => {
    const { f, state } = manager();
    const v = await openPicker(f);
    state.bots = [botRow({ status: 'running', ...URL_BOT, webAuth: 'public' })];
    await v.session.refresh();
    await v.untilText('Public (current)');
    expect(flat(v.frame())).not.toContain('Managed (current)');
    expect(keyBar(v.frame())).toContain('Enter Change');
    v.unmount();
  });
});

describe('m6 web login: the change', () => {
  it('a change asks Y with the page words; Y sends one PUT and the outcome reaches the bot screen', async () => {
    const { f, state } = manager();
    f.on('PUT', PUT, () => {
      state.bots = [botRow({ status: 'running', ...URL_BOT, webAuth: 'public' })];
      return saved('public');
    });
    const v = await openPicker(f);
    await v.press(DOWN, ENTER);
    await v.untilText("Change the public URL login of mybot from Managed to Public? It applies on the bot's next Update or Build.");
    expect(flat(v.frame())).toContain('Public URL access:');
    expect(keyBar(v.frame())).toContain('Y Set Public');
    expect(v.puts()).toEqual([]);
    await v.press('y');
    await v.untilText(`mybot: ${WEB_AUTH_SAVED}`);
    expect(flat(v.frame())).toContain('Name mybot');
    expect(v.puts()).toEqual([{ mode: 'public' }]);
    await v.press('w');
    await v.untilText('> Public (current)');
    v.unmount();
  });

  it('another key at the question sends nothing and goes back to the picker', async () => {
    const v = await openPicker(manager().f);
    await v.press(UP, ENTER);
    await v.untilText('from Managed to Auto?');
    await v.press('n');
    await v.untilText('> Auto');
    expect(flat(v.frame())).not.toContain('from Managed to Auto?');
    await tick(100);
    expect(v.puts()).toEqual([]);
    v.unmount();
  });

  it('a refusal shows the route text; no answer and a body that is not JSON give the page text', async () => {
    // bots.ts:2308 (the 400) and :2316 (String(error) of a throw).
    const cases: Array<[Reply, string]> = [
      [refused(400, { success: false, error: "mode must be 'auto', 'managed' or 'public'" }), "mybot: mode must be 'auto', 'managed' or 'public'"],
      [refused(500, { success: false, error: 'Error: EACCES: permission denied, open /data/instances.json' }), 'mybot: Error: EACCES: permission denied, open /data/instances.json'],
      [refused(500, { success: false }), 'mybot: Failed to set web auth mode'],
      [noAnswer(), `mybot: ${WEB_AUTH_NO_ANSWER}`],
      [{ status: 502, ok: false, body: 'Bad Gateway' }, `mybot: ${WEB_AUTH_NO_ANSWER}`],
    ];
    for (const [reply, text] of cases) {
      const { f } = manager();
      f.on('PUT', PUT, reply);
      const v = await openPicker(f);
      await v.press(DOWN, ENTER);
      await v.untilText('from Managed to Public?');
      await v.press('y');
      await v.untilText(text);
      expect(flat(v.frame())).not.toContain(WEB_AUTH_SAVED);
      v.unmount();
    }
  });

  it('a double Y sends one PUT; Esc during the call leaves and the outcome lands through the Session', async () => {
    const { f } = manager();
    const slow = later();
    f.on('PUT', PUT, () => slow.reply());
    const v = await openPicker(f);
    await v.press(DOWN, ENTER);
    await v.untilText('from Managed to Public?');
    await v.press('y', 'y', ENTER);
    await v.untilText('Asked the manager to change the web login of mybot; waiting for the answer.');
    await v.press(ESC);
    await v.untilText('The web login change of mybot goes on');
    await v.press('w');
    await v.untilText('The web login change of mybot is still running; waiting for the manager.');
    expect(v.puts()).toEqual([{ mode: 'public' }]);
    slow.answer(saved('public'));
    await v.untilText(`mybot: ${WEB_AUTH_SAVED}`);
    expect(v.puts()).toEqual([{ mode: 'public' }]);
    v.unmount();
  });
});

describe('m6 web login: columns', () => {
  for (const columns of [80, 100]) {
    it(`the picker, its question and the bot bar fit ${columns} columns whole`, async () => {
      const v = await start(manager().f, { columns });
      await v.press(ENTER);
      await v.untilText('Name mybot');
      expect(keyBar(v.frame())).toContain('W Web login');
      await v.press('w');
      await v.untilText('Web login of mybot');
      for (const l of v.frame().split('\n')) expect(l.length).toBeLessThanOrEqual(columns - 1);
      expect(flat(v.frame())).toContain('Public disables auth. Applies on the bot\'s next Update or Build.');
      await v.press(DOWN, ENTER);
      await v.untilText('from Managed to Public?');
      for (const l of v.frame().split('\n')) expect(l.length).toBeLessThanOrEqual(columns - 1);
      expect(flat(v.frame())).toContain("It applies on the bot's next Update or Build.");
      v.unmount();
    });
  }
});
