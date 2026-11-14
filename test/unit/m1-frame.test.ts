import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import * as ink from 'ink';
import { render } from 'ink-testing-library';
import { createApp, frameLines, FrameState, scrollWindow } from '../../src/cli/tui/app';
import { handOffCommand, screenModes } from '../../src/cli/tui/run';
import { Session } from '../../src/cli/tui/session';
import { bot, FakeScript, fakeClient, listBody, nextOpId, ok, refused, script } from './m1-fake';

const App = createApp(ink);
const DOWN = '\u001B[B';
const ESC = '\u001B';

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

async function start(sc: FakeScript, initial?: FrameState, canHandOff = false) {
  const session = new Session(fakeClient(sc), () => 0);
  await session.refresh();
  const onHandOff = vi.fn();
  const view = render(createElement(App, { machine: 'box1', session, initial, onHandOff, canHandOff, now: () => 0 }));
  await tick();
  const frame = () => view.lastFrame() ?? '';
  const press = async (...keys: string[]) => {
    for (const k of keys) {
      view.stdin.write(k);
      await tick();
    }
  };
  const until = async (text: string) => {
    for (let i = 0; i < 100 && !frame().includes(text); i++) await tick(20);
    expect(frame()).toContain(text);
  };
  return { ...view, session, onHandOff, frame, press, until };
}

const keyBar = (frame: string) => frame.split('\n').at(-2) ?? '';
const selectedRow = (frame: string) => frame.split('\n').find((l) => /^\| > /.test(l))?.slice(4).split(/\s{2,}/)[0];

function twoBots(over: Partial<FakeScript> = {}) {
  return script({
    reply: (method, path) => {
      if (method === 'GET' && path === '/api/bots') return ok(listBody([bot(), bot({ id: 'b2', displayName: 'imgbot', status: 'stopped', sourceType: 'docker-image' })]));
      return refused(404, { success: false, error: 'Bot not found' });
    },
    ...over,
  });
}

function withRoute(sc: FakeScript, method: string, path: string, answer: () => ReturnType<FakeScript['reply']>): FakeScript {
  const real = sc.reply;
  sc.reply = (m, p) => (m === method && p === path ? answer() : real(m, p));
  return sc;
}

describe('m1 bot list', () => {
  it('shows the columns, the rows and only the keys the list takes', async () => {
    const v = await start(twoBots());
    const f = v.frame();
    expect(f.split('\n')[0].startsWith('+ Bot Manager - box1 -')).toBe(true);
    expect(f).toMatch(/Bots\s+Status\s+Data\s+Copy\s+Last backup/);
    expect(f).toMatch(/> mybot\s+running\s+-\s+-\s+-/);
    expect(keyBar(f)).toMatch(/^\| Enter Open {2}I Install {2}V Vault {2}Q Quit\s+\|$/);
    await v.press(DOWN);
    expect(selectedRow(v.frame())).toBe('imgbot');
    v.unmount();
  });

  it('says when the list read failed and shows no rows as current', async () => {
    let fail = false;
    const sc = twoBots();
    const real = sc.reply;
    sc.reply = (m, p) => (fail ? new Error('connect ECONNREFUSED 127.0.0.1:8080') : real(m, p));
    const v = await start(sc);
    fail = true;
    await v.session.refresh();
    await tick();
    const f = v.frame();
    expect(f).toContain("can't read the bot list: connect ECONNREFUSED 127.0.0.1:8080");
    expect(f).not.toContain('mybot');
    expect(keyBar(f)).toMatch(/^\| Q Quit\s+\|$/);
    v.unmount();
  });

  it('offers no hand-off key and runs nothing on H when no command is named', async () => {
    const v = await start(twoBots());
    expect(v.frame()).not.toContain('Hand-off');
    await v.press(DOWN, 'h', '\r');
    expect(v.onHandOff).not.toHaveBeenCalled();
    expect(v.frame()).not.toContain('Hand-off');
    v.unmount();
  });

  it('hands off from the list and the bot screen with their state when a command is named', async () => {
    const v = await start(twoBots(), undefined, true);
    expect(keyBar(v.frame())).toMatch(/^\| Enter Open {2}I Install {2}V Vault {2}H Hand-off {2}Q Quit\s+\|$/);
    await v.press(DOWN, 'h');
    expect(v.onHandOff).toHaveBeenCalledWith({ screen: 'list', index: 1 });
    v.unmount();
    const b = await start(twoBots(), undefined, true);
    await b.press('\r');
    expect(b.frame().split('\n').slice(-3, -1).join(' ')).toMatch(/G Build logs {2}T State {2}H Hand-off\s.*Esc Back/);
    await b.press('h');
    expect(b.onHandOff).toHaveBeenCalledWith({ screen: 'bot', index: 0, botId: 'b1' });
    b.unmount();
  });
});

describe('m1 bot screen', () => {
  it('offers Stop for a running git bot and no Install, Database or Files keys', async () => {
    const v = await start(twoBots());
    await v.press('\r');
    const f = v.frame();
    expect(f).toContain('Name         mybot');
    expect(keyBar(f)).toMatch(/S Stop {2}R Restart {2}B Build {2}U Update {2}L Logs {2}G Build logs {2}T State {2}Esc Back {2}Q Quit/);
    expect(keyBar(f)).not.toMatch(/Install|Database|Files/);
    v.unmount();
  });

  it('offers Start and no Update for a stopped image bot', async () => {
    const v = await start(twoBots());
    await v.press(DOWN, '\r');
    expect(keyBar(v.frame())).toMatch(/S Start {2}R Restart {2}B Build {2}L Logs/);
    expect(keyBar(v.frame())).not.toContain('U Update');
    v.unmount();
  });

  it('keeps the bot screen on a read failure and dates its values', async () => {
    let fail = false;
    const sc = twoBots();
    const real = sc.reply;
    sc.reply = (m, p) => (fail ? new Error('socket hang up') : real(m, p));
    const v = await start(sc);
    await v.press('\r');
    fail = true;
    await v.session.refresh();
    await tick();
    expect(v.frame()).toContain("can't read the bot list: socket hang up");
    expect(v.frame()).toContain('The values above were read at');
    v.unmount();
  });
});

describe('m1 dialogs', () => {
  it('asks for Y before stop; another key cancels and sends nothing', async () => {
    const sc = twoBots();
    const v = await start(sc);
    await v.press('\r', 's');
    expect(v.frame()).toContain('Stop mybot?');
    expect(v.frame()).toContain('The bot goes offline until it is started again.');
    expect(keyBar(v.frame())).toMatch(/Y Stop {2}any other key Cancel/);
    await v.press('n');
    expect(v.frame()).toContain('Cancelled: mybot was not stopped.');
    expect(sc.requests.filter((r) => r.method === 'POST')).toEqual([]);
    v.unmount();
  });

  it('stops on Y and says Stopped only after the success answer', async () => {
    const sc = withRoute(twoBots(), 'POST', '/api/bots/b1/stop', () => ok({ success: true, bot: bot({ status: 'stopped' }) }));
    const v = await start(sc);
    await v.press('\r', 's', 'y');
    await v.until('Stopped mybot.');
    expect(sc.requests.filter((r) => r.method === 'POST')).toEqual([{ method: 'POST', path: '/api/bots/b1/stop' }]);
    v.unmount();
  });

  it('asks for Y before restart; Esc cancels', async () => {
    const sc = twoBots();
    const v = await start(sc);
    await v.press('\r', 'r');
    expect(v.frame()).toContain('Restart mybot?');
    await v.press(ESC);
    expect(v.frame()).toContain('Cancelled: mybot was not restarted.');
    expect(sc.requests.filter((r) => r.method === 'POST')).toEqual([]);
    v.unmount();
  });

  it('restarts on Y and shows the failure event text', async () => {
    const sc = withRoute(
      twoBots({ events: (_p, opId) => [{ type: 'bot:restart-failed', data: { id: 'b1', opId, error: 'compose up exited 1' } }] }),
      'POST', '/api/bots/b1/restart', () => ok({ success: true, message: 'Restarting bot', opId: nextOpId() }),
    );
    const v = await start(sc);
    await v.press('\r', 'r', 'y');
    await v.until('Could not restart mybot: compose up exited 1');
    v.unmount();
  });

  it('starts a stopped bot without a dialog', async () => {
    const sc = withRoute(
      twoBots({ events: (_p, opId) => [{ type: 'bot:started', data: { ...bot({ id: 'b2' }), opId } }] }),
      'POST', '/api/bots/b2/start', () => ok({ success: true, message: 'Starting bot', opId: nextOpId() }),
    );
    const v = await start(sc);
    await v.press(DOWN, '\r', 's');
    await v.until('Started imgbot.');
    v.unmount();
  });
});

describe('m1 progress and logs', () => {
  it('shows a build with live progress and its result', async () => {
    const sc = withRoute(
      twoBots({
        events: (_p, opId) => [{ type: 'bot:built', data: { ...bot(), opId } }],
        streams: {
          '/api/bots/b1/build-logs': {
            frames: [
              { event: 'message', data: { message: 'Step 1/4 : FROM node:20-alpine', type: 'info', timestamp: 1 } },
              { event: 'message', data: { type: 'done', op: 'build', finalStatus: 'stopped', currentStatus: 'stopped', timestamp: 2 } },
            ],
            then: 'end',
          },
        },
      }),
      'POST', '/api/bots/b1/build', () => ok({ success: true, message: 'Build started', opId: nextOpId() }),
    );
    const v = await start(sc);
    await v.press('\r', 'b');
    await v.until('Built mybot.');
    await v.until('Step 1/4 : FROM node:20-alpine');
    await v.until('The build finished. Bot status: stopped.');
    expect(keyBar(v.frame())).toMatch(/Up\/Down Scroll {2}End Follow {2}Esc Back {2}Q Quit/);
    await v.press(ESC);
    expect(v.frame().split('\n').slice(-3, -1).join(' ')).toContain('P Progress');
    v.unmount();
  });

  it('follows a container log, and Esc stops the stream', async () => {
    const path = '/api/bots/b1/containers/mybot-app-1/logs/stream?lines=200';
    const sc = withRoute(
      twoBots({
        streams: {
          [path]: {
            frames: [
              { event: 'connected', data: { message: 'Connected to mybot-app-1 logs' } },
              { event: 'log', data: { log: 'Logged in as mybot', timestamp: '2026-11-14T06:00:00Z' } },
            ],
            then: 'hang',
          },
        },
      }),
      'GET', '/api/bots/b1/containers',
      () => ok({ success: true, containers: [{ name: 'mybot-app-1', state: 'running', status: 'Up 2 hours' }], appName: 'mybot' }),
    );
    const v = await start(sc);
    await v.press('\r', 'l');
    await v.until('mybot-app-1  running  Up 2 hours');
    await v.press('\r');
    await v.until('Logged in as mybot');
    await v.press(ESC);
    await tick();
    expect(sc.sseAborted).toEqual([path]);
    expect(v.frame()).toContain('Containers of mybot');
    v.unmount();
  });

  it("shows the containers route's error", async () => {
    const sc = withRoute(twoBots(), 'GET', '/api/bots/b1/containers',
      () => refused(503, { success: false, error: 'Docker did not answer, so the containers of this bot could not be listed' }));
    const v = await start(sc);
    await v.press('\r', 'l');
    await v.until('Could not list the containers of mybot: Docker did not answer');
    v.unmount();
  });

  it('shows the build log stream and its error', async () => {
    const v = await start(twoBots());
    await v.press('\r', 'g');
    await v.until('The stream failed: SSE /api/bots/b1/build-logs returned 404');
    v.unmount();
  });
});

describe('m1 frame layout and setup', () => {
  it('fills the terminal one column short and one row short', () => {
    const lines = frameLines('box1', { body: ['a'], keys: 'Q Quit' }, 100, 30);
    expect(lines).toHaveLength(29);
    for (const l of lines) expect(l).toHaveLength(99);
  });

  it('scrolls back from the end and follows at 0', () => {
    const lines = ['1', '2', '3', '4', '5'];
    expect(scrollWindow(lines, 2, 0)).toEqual(['4', '5']);
    expect(scrollWindow(lines, 2, 2)).toEqual(['2', '3']);
    expect(scrollWindow(lines, 2, 99)).toEqual(['1', '2']);
  });

  it('names a hand-off command only from DBM_TUI_CHECK_HANDOFF', () => {
    expect(handOffCommand({ DBM_TUI_CHECK_HANDOFF: 'sh' })).toBe('sh');
    expect(handOffCommand({})).toBeUndefined();
    expect(handOffCommand({ DBM_TUI_CHECK_HANDOFF: '' })).toBeUndefined();
    expect(handOffCommand({ SHELL: '/bin/bash', ComSpec: 'cmd.exe' })).toBeUndefined();
  });

  it('uses the alternate screen except on Windows', () => {
    expect(screenModes('linux')).toEqual({ enter: '\x1b[?1049h', leave: '\x1b[?1049l' });
    expect(screenModes('win32').enter).not.toContain('1049');
  });
});
