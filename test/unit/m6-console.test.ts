import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import * as ink from 'ink';
import { render } from 'ink-testing-library';
import { createApp, FrameState } from '../../src/cli/tui/app';
import { Session } from '../../src/cli/tui/session';
import { NO_DOCKER } from '../../src/cli/tui/shell';
import { botList, fake, Fake, noAnswer, ok, refused, Reply } from './m2-fake';
import { botRow } from './m3-fake';

const App = createApp(ink);
vi.setConfig({ testTimeout: 30_000 });
const ESC = '\u001B';
const ENTER = '\r';
const UP = '\u001B[A';
const DOWN = '\u001B[B';
const CONTAINERS = '/api/bots/b1/containers';
const WAIT_MS = 10_000;

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const flat = (frame: string) => frame.split('\n').map((l) => l.replace(/^\| /, '').replace(/\s*\|$/, '').trim()).join(' ').replace(/\s+/g, ' ');

// Rows of listProjectContainers (dockerClient.ts:787 to :793): docker ps's Names, State and Status.
const row = (name: string, state = 'running', status = 'Up 2 hours') => ({ name, state, status });
// GET /api/bots/:id/containers success (bots.ts:942).
const containersBody = (rows: unknown[]) => ok({ success: true, containers: rows, appName: 'mybot' });

function base(rows: unknown[] | Reply | ((body: unknown) => Reply | Promise<Reply>), bots = [botRow({ status: 'running' })]): Fake {
  const f = fake().on('GET', '/api/bots', botList(bots));
  return f.on('GET', CONTAINERS, Array.isArray(rows) ? containersBody(rows) : rows);
}

function later() {
  let answer: (r: Reply) => void = () => {};
  const p = new Promise<Reply>((resolve) => {
    answer = resolve;
  });
  return { reply: () => p, answer: (r: Reply) => answer(r) };
}

async function start(f: Fake, opts: { columns?: number; readLimitMs?: number; initial?: FrameState; noShell?: boolean } = {}) {
  const session = new Session(f.client, () => 0);
  await session.refresh();
  const shells: Array<{ state: FrameState; container: string }> = [];
  const view = render(createElement(App, {
    machine: 'box1', session, onHandOff: vi.fn(), now: () => 0,
    ...(opts.noShell ? {} : { onShell: (state: FrameState, container: string) => shells.push({ state, container }) }),
    shellOptions: { readLimitMs: opts.readLimitMs ?? 5000 },
    ...(opts.initial ? { initial: opts.initial } : {}),
  }));
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
  const gets = () => f.paths().filter((p) => p === `GET ${CONTAINERS}`).length;
  return { ...view, session, shells, frame, press, until, untilText, gets };
}

async function openBot(f: Fake, opts: Parameters<typeof start>[1] = {}) {
  const v = await start(f, opts);
  await v.press(ENTER);
  await v.untilText('Name mybot');
  return v;
}

describe('m6 console: O reads the containers', () => {
  it('one running container goes straight to the shell, for the bot screen, with one GET', async () => {
    const v = await openBot(base([row('mybot-bot-1'), row('mybot-db-1', 'exited', 'Exited (0) 1 hour ago')]));
    expect(v.frame()).toContain('O Console');
    await v.press('o');
    await v.until(() => v.shells.length === 1, 'the shell hand-off');
    expect(v.shells[0].container).toBe('mybot-bot-1');
    expect(v.shells[0].state).toMatchObject({ screen: 'bot', botId: 'b1' });
    await v.press('o', ENTER);
    await tick(200);
    expect(v.shells.length).toBe(1);
    expect(v.gets()).toBe(1);
    v.unmount();
  });

  it('several running containers open the pick list; Enter opens the one under the cursor', async () => {
    const v = await openBot(base([row('mybot-bot-1'), row('mybot-worker-1', 'running', 'Up 5 minutes'), row('mybot-db-1', 'exited')]));
    await v.press('o');
    await v.untilText('Open a shell in a container of mybot');
    const text = flat(v.frame());
    expect(text).toContain('> mybot-bot-1 Up 2 hours');
    expect(text).toContain('mybot-worker-1 Up 5 minutes');
    expect(text).not.toContain('mybot-db-1');
    expect(text).toContain('Enter Open shell Up/Down Pick R Read again Esc Back Q Quit');
    await v.press(DOWN, ENTER);
    await v.until(() => v.shells.length === 1, 'the shell hand-off');
    expect(v.shells[0].container).toBe('mybot-worker-1');
    expect(v.shells[0].state.screen).toBe('bot');
    v.unmount();
  });

  it('no running container says so and opens nothing', async () => {
    const v = await openBot(base([row('mybot-bot-1', 'exited', 'Exited (1) 3 minutes ago')]));
    await v.press('o');
    await v.untilText('mybot has no running containers.');
    expect(v.shells).toEqual([]);
    v.unmount();
  });

  it("a refusal shows the route's text and opens nothing (bots.ts:939)", async () => {
    const v = await openBot(base(refused(503, { success: false, error: 'Docker did not answer, so the containers of this bot could not be listed' })));
    await v.press('o');
    await v.untilText('Could not list the containers of mybot: Docker did not answer, so the containers of this bot could not be listed.');
    expect(v.shells).toEqual([]);
    v.unmount();
  });

  it('no answer, a body that is not a JSON object and the time limit show their text and open nothing', async () => {
    const a = await openBot(base(noAnswer()));
    await a.press('o');
    await a.untilText('Could not list the containers of mybot: connect ECONNREFUSED 127.0.0.1:8080.');
    a.unmount();
    const b = await openBot(base({ status: 502, ok: false, body: 'Bad Gateway' }));
    await b.press('o');
    await b.untilText('Could not list the containers of mybot: the reply was not JSON, HTTP 502.');
    b.unmount();
    const c = await openBot(base(() => new Promise<Reply>(() => {})), { readLimitMs: 300 });
    await c.press('o');
    await c.untilText('Reading the containers of mybot.');
    await c.untilText('Could not list the containers of mybot: the manager did not answer within 300 ms.');
    expect([a, b, c].flatMap((x) => x.shells)).toEqual([]);
    c.unmount();
  });

  it('a second O while the read runs sends no second GET', async () => {
    const l = later();
    const v = await openBot(base(l.reply));
    await v.press('o', 'o', 'o');
    expect(v.gets()).toBe(1);
    l.answer(containersBody([row('mybot-bot-1')]));
    await v.until(() => v.shells.length === 1, 'the shell hand-off');
    expect(v.gets()).toBe(1);
    v.unmount();
  });

  it('an answer that lands after Esc opens nothing', async () => {
    const l = later();
    const v = await openBot(base(l.reply));
    await v.press('o', ESC);
    await v.untilText('Bots');
    l.answer(containersBody([row('mybot-bot-1')]));
    await tick(300);
    expect(v.shells).toEqual([]);
    expect(flat(v.frame())).not.toContain('Open a shell');
    v.unmount();
  });

  it('an answer that lands after the operator moved to another bot opens nothing', async () => {
    const l = later();
    const f = base(l.reply, [botRow({ status: 'running' }), botRow({ id: 'b2', displayName: 'other', status: 'running' })]);
    const v = await openBot(f);
    await v.press('o', ESC, DOWN, ENTER);
    await v.untilText('Name other');
    l.answer(containersBody([row('mybot-bot-1'), row('mybot-worker-1')]));
    await tick(300);
    expect(v.shells).toEqual([]);
    expect(flat(v.frame())).toContain('Name other');
    v.unmount();
  });

  it('a bot that is not running offers no O, and O says why and reads nothing', async () => {
    const v = await openBot(base([row('mybot-bot-1')], [botRow({ status: 'stopped' })]));
    expect(v.frame()).not.toContain('O Console');
    await v.press('o');
    await v.untilText('Start the bot to open a console.');
    expect(v.gets()).toBe(0);
    v.unmount();
  });
});

describe('m6 console: the pick list', () => {
  const three = [row('mybot-a-1'), row('mybot-b-1'), row('mybot-c-1')];

  it('Esc goes back to the bot screen and opens nothing', async () => {
    const v = await openBot(base(three));
    await v.press('o');
    await v.untilText('Open a shell in a container of mybot');
    await v.press(ESC);
    await v.untilText('Name mybot');
    expect(v.shells).toEqual([]);
    v.unmount();
  });

  it('a re-read that moves another row under the cursor makes Enter send nothing until Up or Down picks', async () => {
    let rows = three;
    const v = await openBot(base(() => containersBody(rows)));
    await v.press('o');
    await v.untilText('Open a shell in a container of mybot');
    await v.press(DOWN);
    await v.untilText('> mybot-b-1');
    rows = [row('mybot-new-1'), row('mybot-a-1'), row('mybot-b-1')];
    await v.press('r');
    await v.untilText('mybot-new-1');
    const text = flat(v.frame());
    expect(text).not.toContain('>');
    expect(text).not.toContain('Enter Open shell');
    await v.press(ENTER);
    await tick(200);
    expect(v.shells).toEqual([]);
    await v.press(DOWN);
    await v.untilText('> mybot-b-1');
    await v.press(ENTER);
    await v.until(() => v.shells.length === 1, 'the shell hand-off');
    expect(v.shells[0].container).toBe('mybot-b-1');
    v.unmount();
  });

  it('a re-read that keeps the picked row under the cursor keeps the pick', async () => {
    const v = await openBot(base(three));
    await v.press('o');
    await v.untilText('Open a shell in a container of mybot');
    await v.press(DOWN, 'r');
    await v.until(() => v.gets() === 2, 'the second read');
    await v.untilText('> mybot-b-1');
    await v.press(ENTER);
    await v.until(() => v.shells.length === 1, 'the shell hand-off');
    expect(v.shells[0].container).toBe('mybot-b-1');
    v.unmount();
  });

  it('a refused re-read shows its text and keeps the list', async () => {
    let answer: Reply = containersBody(three);
    const v = await openBot(base(() => answer));
    await v.press('o');
    await v.untilText('Open a shell in a container of mybot');
    answer = refused(500, { success: false, error: 'Error: spawn docker EACCES' });
    await v.press('r');
    await v.untilText('Could not list the containers of mybot: Error: spawn docker EACCES.');
    expect(flat(v.frame())).toContain('> mybot-a-1');
    v.unmount();
  });
});

describe('m6 console: 80 columns', () => {
  const long = 'a-very-long-compose-project-name-for-the-bot-with-many-words-worker-1';

  it('the bot bar wraps with O, and the pick list wraps a long name whole', async () => {
    const v = await openBot(base([row('mybot-bot-1'), row(long, 'running', 'Up 3 days (healthy)')]), { columns: 80 });
    for (const l of v.frame().split('\n')) expect(l.length).toBeLessThanOrEqual(80);
    expect(flat(v.frame())).toContain('O Console');
    await v.press('o');
    await v.untilText('Open a shell in a container of mybot');
    const lines = v.frame().split('\n');
    for (const l of lines) expect(l.length).toBeLessThanOrEqual(80);
    expect(flat(v.frame()).replace(/\s/g, '')).toContain(`${long}Up3days(healthy)`);
    v.unmount();
  });

  it('the ENOENT text after a hand-off shows whole on the bot screen', async () => {
    const v = await start(base([row('mybot-bot-1')]), { columns: 80, initial: { screen: 'bot', index: 0, botId: 'b1', notice: NO_DOCKER } });
    await v.untilText('Name mybot');
    for (const l of v.frame().split('\n')) expect(l.length).toBeLessThanOrEqual(80);
    expect(flat(v.frame())).toContain(NO_DOCKER);
    v.unmount();
  });

  it('without a hand-off, O says no shell can be opened', async () => {
    const v = await openBot(base([row('mybot-bot-1')]), { noShell: true });
    await v.press('o');
    await v.untilText('No shell can be opened here.');
    v.unmount();
  });
});
