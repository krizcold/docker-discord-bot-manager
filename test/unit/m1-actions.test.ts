import { describe, expect, it } from 'vitest';
import {
  Bot, buildFrameLine, containerFrameLine, followStream, lifecycleAction, listBots, StreamLines, stopBot,
} from '../../src/cli/tui/api';
import { copyText, dataText, lastBackupText, updateText } from '../../src/cli/tui/format';
import { Session } from '../../src/cli/tui/session';
import { bot, fakeClient, listBody, nextOpId, ok, refused, script } from './m1-fake';

const b1 = bot() as unknown as Bot;
const BUSY = { success: false, error: "Operation 'build' already in progress" };

describe('m1 bot list read', () => {
  it('returns the bots of a successful answer', async () => {
    const c = fakeClient(script({ reply: () => ok(listBody([bot(), bot({ id: 'b2', displayName: 'other' })])) }));
    expect((await listBots(c)).map((b) => b.id)).toEqual(['b1', 'b2']);
  });

  it("fails with the route's own error text", async () => {
    const c = fakeClient(script({ reply: () => refused(503, { success: false, broken: true, error: 'The bot registry could not be read' }) }));
    await expect(listBots(c)).rejects.toThrow('The bot registry could not be read');
  });

  it('fails with the connection error when the manager does not answer', async () => {
    const c = fakeClient(script({ reply: () => new Error('connect ECONNREFUSED 127.0.0.1:8080') }));
    await expect(listBots(c)).rejects.toThrow('connect ECONNREFUSED 127.0.0.1:8080');
  });

  it('keeps the last bots but records the failure, and clears it on the next good read', async () => {
    let fail = false;
    const s = new Session(fakeClient(script({ reply: () => (fail ? new Error('socket hang up') : ok(listBody([bot()]))) })), () => 1000);
    await s.refresh();
    expect(s.list).toEqual({ bots: [expect.objectContaining({ id: 'b1' })], readAt: 1000, error: null });
    fail = true;
    await s.refresh();
    expect(s.list.error).toBe('socket hang up');
    expect(s.list.readAt).toBe(1000);
    fail = false;
    await s.refresh();
    expect(s.list.error).toBeNull();
  });
});

describe('m1 stop', () => {
  it('says Stopped only on a success answer, with its warning', async () => {
    const sc = script({ reply: () => ok({ success: true, bot: bot({ status: 'stopped' }), warning: 'the web port was not released' }) });
    expect(await stopBot(fakeClient(sc), b1)).toEqual({ ok: true, text: 'Stopped mybot. Warning: the web port was not released' });
    expect(sc.requests).toEqual([{ method: 'POST', path: '/api/bots/b1/stop' }]);
  });

  it("shows the route's error on a refusal", async () => {
    const c = fakeClient(script({ reply: () => refused(400, { success: false, error: 'docker compose stop exited 1' }) }));
    expect(await stopBot(c, b1)).toEqual({ ok: false, text: 'Could not stop mybot: docker compose stop exited 1' });
  });

  it("says can't confirm when no answer came", async () => {
    const c = fakeClient(script({ reply: () => new Error('socket hang up') }));
    expect(await stopBot(c, b1)).toEqual({ ok: null, text: "can't confirm whether mybot stopped: the manager did not answer (socket hang up)." });
  });
});

function lifecycleScript(kind: string, outcome: 'ok' | 'fail', extra: Record<string, unknown> = {}) {
  const types: Record<string, [string, string]> = {
    start: ['bot:started', 'bot:start-failed'],
    restart: ['bot:restarted', 'bot:restart-failed'],
    build: ['bot:built', 'bot:build-failed'],
    update: ['bot:rebuilt', 'bot:pull-failed'],
  };
  const messages: Record<string, string> = { start: 'Starting bot', restart: 'Restarting bot', build: 'Build started', update: 'Updating instance from source' };
  return script({
    reply: (method, path) => (method === 'POST' && path === `/api/bots/b1/${kind}` ? ok({ success: true, message: messages[kind], opId: nextOpId() }) : refused(404, { success: false, error: 'Bot not found' })),
    events: (_path, opId) => [
      { type: types[kind][0], data: { ...bot(), opId: 'someone-else' } },
      outcome === 'ok'
        ? { type: types[kind][0], data: { ...bot(), opId, ...extra } }
        : { type: types[kind][1], data: { id: 'b1', opId, error: 'compose up exited 1' } },
    ],
  });
}

describe('m1 start, restart, build and update', () => {
  const done: Record<string, string> = { start: 'Started mybot.', restart: 'Restarted mybot.', build: 'Built mybot.', update: 'Updated mybot from its source.' };
  for (const kind of ['start', 'restart', 'build', 'update'] as const) {
    it(`${kind}: success only on its own operation's success event`, async () => {
      const sc = lifecycleScript(kind, 'ok');
      expect(await lifecycleAction(fakeClient(sc), b1, kind)).toEqual({ ok: true, text: done[kind] });
      expect(sc.requests).toEqual([{ method: 'POST', path: `/api/bots/b1/${kind}` }]);
    });

    it(`${kind}: the failure event's error`, async () => {
      expect(await lifecycleAction(fakeClient(lifecycleScript(kind, 'fail')), b1, kind)).toEqual({ ok: false, text: `Could not ${kind} mybot: compose up exited 1` });
    });

    it(`${kind}: the route's refusal`, async () => {
      const c = fakeClient(script({ reply: () => refused(409, BUSY) }));
      expect(await lifecycleAction(c, b1, kind)).toEqual({ ok: false, text: `Could not ${kind} mybot: Operation 'build' already in progress` });
    });
  }

  it('carries the warning of a started event', async () => {
    const r = await lifecycleAction(fakeClient(lifecycleScript('start', 'ok', { warning: 'the database copy is behind' })), b1, 'start');
    expect(r.text).toBe('Started mybot. Warning: the database copy is behind');
  });

  it('says the request was not sent when the event channel cannot open', async () => {
    const sc = lifecycleScript('start', 'ok');
    sc.wsFails = 'connect ECONNREFUSED 127.0.0.1:8080';
    const r = await lifecycleAction(fakeClient(sc), b1, 'start');
    expect(r).toEqual({ ok: false, text: 'Could not reach the manager (event channel closed before completion: connect ECONNREFUSED 127.0.0.1:8080), so mybot was not asked to start.' });
    expect(sc.requests).toEqual([]);
  });

  it("says can't confirm when the POST got no answer", async () => {
    const c = fakeClient(script({ reply: () => new Error('socket hang up') }));
    expect(await lifecycleAction(c, b1, 'restart')).toEqual({ ok: null, text: "can't confirm whether mybot restarted: the manager did not answer (socket hang up)." });
  });

  it("says can't confirm when the event channel closes after the manager accepted", async () => {
    const sc = lifecycleScript('build', 'ok');
    sc.wsClosesAfterPost = 'closed (code 1006)';
    expect(await lifecycleAction(fakeClient(sc), b1, 'build')).toEqual({
      ok: null, text: "can't confirm whether the build of mybot finished: event channel closed before completion: closed (code 1006).",
    });
  });

  it("says can't confirm when the accepted answer names no operation", async () => {
    const c = fakeClient(script({ reply: () => ok({ success: true, message: 'Starting bot' }) }));
    expect(await lifecycleAction(c, b1, 'start')).toEqual({ ok: null, text: "can't confirm whether mybot started: the manager accepted the request but named no operation to follow." });
  });

  it('refuses update for an image bot with the route text', async () => {
    const c = fakeClient(script({ reply: () => refused(400, { success: false, error: 'Cannot update docker-image instances this way' }) }));
    expect((await lifecycleAction(c, b1, 'update')).text).toBe('Could not update mybot: Cannot update docker-image instances this way');
  });

  it('follows the build log once the build was accepted, and the result still comes from the event', async () => {
    const sc = lifecycleScript('build', 'ok');
    sc.streams['/api/bots/b1/build-logs'] = {
      frames: [
        { event: 'message', data: { message: 'Step 1/4', type: 'info', timestamp: 1 } },
        { event: 'message', data: { type: 'status', op: 'build', startedAt: 1, sinceLastLogMs: 0, timestamp: 2 } },
        { event: 'message', data: { message: 'npm ci', type: 'progress', key: 'npm', timestamp: 3 } },
        { event: 'message', data: { message: 'npm ci done', type: 'progress', key: 'npm', timestamp: 4 } },
        { event: 'message', data: { message: 'cache miss', type: 'warning', timestamp: 5 } },
        { event: 'message', data: { type: 'done', op: 'build', durationMs: 9, finalStatus: 'stopped', currentStatus: 'stopped', timestamp: 6 } },
      ],
      then: 'end',
    };
    const s = new Session(fakeClient(sc));
    const r = await s.act(b1, 'build');
    expect(r).toEqual({ ok: true, text: 'Built mybot.' });
    for (let i = 0; i < 100 && !s.runs.get('b1')?.progress?.end; i++) await new Promise((res) => setTimeout(res, 20));
    expect(s.runs.get('b1')?.progress).toEqual({
      lines: ['Step 1/4', 'npm ci done', 'Warning: cache miss'],
      end: { ok: true, text: 'The build finished. Bot status: stopped.' },
    });
    expect(s.notice).toBe('Built mybot.');
  });

  it('runs one action per bot at a time', async () => {
    const s = new Session(fakeClient(lifecycleScript('start', 'ok')));
    const first = s.act(b1, 'start');
    expect(await s.act(b1, 'stop')).toBeNull();
    expect((await first)?.ok).toBe(true);
  });
});

describe('m1 streams', () => {
  const run = async (frames: Array<{ event: string; data: unknown }>, then: 'end' | Error, parse = containerFrameLine) => {
    const sc = script({ streams: { '/x': { frames, then } } });
    const state: StreamLines = { lines: [], end: null };
    await followStream(fakeClient(sc), '/x', parse, state, () => {});
    return state;
  };

  it('ends a container log on its end frame', async () => {
    const s = await run([
      { event: 'connected', data: { message: 'Connected to mybot-app-1 logs' } },
      { event: 'log', data: { log: 'ready', timestamp: '2026-11-14T06:00:00Z' } },
      { event: 'ping', data: { timestamp: '2026-11-14T06:00:30Z' } },
      { event: 'end', data: { code: 0 } },
    ], 'end');
    expect(s).toEqual({ lines: ['ready'], end: { ok: true, text: 'docker logs exited; the stream ended.' } });
    expect((await run([{ event: 'end', data: { code: 1 } }], 'end')).end?.text).toBe('docker logs ended: exit code 1');
    expect((await run([{ event: 'end', data: { code: null, error: 'spawn docker ENOENT' } }], 'end')).end?.text).toBe('docker logs ended: spawn docker ENOENT');
  });

  it('says when the manager closed the stream without an end frame', async () => {
    expect((await run([{ event: 'log', data: { log: 'a', timestamp: null } }], 'end')).end).toEqual({ ok: null, text: 'The manager closed the stream before it ended.' });
  });

  it('says when the stream failed', async () => {
    expect((await run([], new Error('SSE /x returned 403'))).end).toEqual({ ok: false, text: 'The stream failed: SSE /x returned 403' });
  });

  it('stops quietly when the view aborts it', async () => {
    const sc = script({ streams: { '/x': { frames: [], then: 'hang' } } });
    const state: StreamLines = { lines: [], end: null };
    const abort = new AbortController();
    const done = followStream(fakeClient(sc), '/x', containerFrameLine, state, () => {}, abort.signal);
    abort.abort();
    await done;
    expect(state.end).toBeNull();
    expect(sc.sseAborted).toEqual(['/x']);
  });

  it('reads the build log terminal frames as dbm bots build-logs does', () => {
    expect(buildFrameLine({ event: 'message', data: { type: 'idle', status: 'running', cutOp: { op: 'build' }, timestamp: 1 } }).end)
      .toEqual({ ok: null, text: "A manager restart cut the bot's last operation, so its outcome can't be confirmed." });
    expect(buildFrameLine({ event: 'message', data: { type: 'idle', status: 'running', timestamp: 1 } }).end?.text).toBe('No operation is running. Bot status: running.');
    expect(buildFrameLine({ event: 'message', data: { type: 'failed', op: 'update', error: 'git fetch failed', timestamp: 1 } }).end)
      .toEqual({ ok: false, text: 'The update failed: git fetch failed' });
  });
});

describe('m1 columns', () => {
  it('shows "-" where the list route gives no value', () => {
    const bare = { id: 'b9' } as Bot;
    expect([dataText(bare), copyText(bare), lastBackupText(bare, 0)]).toEqual(['-', '-', '-']);
    expect(lastBackupText({ id: 'b9', fleetBackup: { main: { lastAt: null }, copy: null } } as Bot, 0)).toBe('-');
  });

  it('names the data place and copy role the route reports', () => {
    expect(dataText({ id: 'x', fleetDb: { replication: {} } } as Bot)).toBe('Postgres');
    expect(copyText({ id: 'x', fleetDb: { replication: {} } } as Bot)).toBe('main');
    expect(copyText({ id: 'x', fleetDbReplica: {} } as Bot)).toBe('copy here');
    expect(copyText({ id: 'x', fleetDbReplica: { copyCleared: true } } as Bot)).toBe('cleared');
    expect(copyText({ id: 'x', fleetDbReplicaSeed: { phase: 'seeding' } } as Bot)).toBe('seed seeding');
    expect(dataText({ id: 'x', dataPlace: 'json' } as Bot)).toBe('files');
    expect(dataText({ id: 'x', dataPlace: null } as Bot)).toBe("can't confirm");
  });

  it('dates the newest backup of either family', () => {
    const now = 10 * 3600_000;
    expect(lastBackupText({ id: 'x', fleetBackup: { main: { lastAt: now - 600_000 }, copy: { lastAt: now - 7200_000 } } } as Bot, now)).toBe('10 min ago');
    expect(lastBackupText({ id: 'x', fleetBackup: { main: null, copy: { lastAt: now - 7200_000 } } } as Bot, now)).toBe('2 h ago');
  });

  it("passes the route's can't-confirm update text through", () => {
    expect(updateText({ id: 'x', updateCantConfirm: 'The source checkout could not be read.' } as Bot)).toBe("can't confirm: The source checkout could not be read.");
    expect(updateText({ id: 'x', updateAvailable: true, behindBy: 3 } as Bot)).toBe('available, 3 commits behind');
  });
});
