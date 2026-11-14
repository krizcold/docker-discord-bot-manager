import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import * as ink from 'ink';
import { render } from 'ink-testing-library';
import { createApp } from '../../src/cli/tui/app';
import { Session } from '../../src/cli/tui/session';
import {
  MANAGER_RUNNING_NOTICE, ManagerFollow, NO_RECORD, READING_VERSION, startRead, UPDATE_LIMIT, UPDATE_NO_ANSWER, UPDATE_QUESTION, modeQuestion,
} from '../../src/cli/tui/manager';
import type { ManagerVersion } from '../../src/cli/tui/api';
import { botList, noAnswer, ok, refused, Reply } from './m2-fake';
import { botRow } from './m3-fake';
import { held, wsFake, WsFake } from './m5-lanekit';

const App = createApp(ink);
vi.setConfig({ testTimeout: 30_000 });
const ESC = '\u001B';
const ENTER = '\r';
const DOWN = '\u001B[B';
const WAIT_MS = 10_000;
const T0 = Date.UTC(2026, 10, 14, 10, 0);
const VERSION = '/api/manager/version';
const UPDATE = '/api/manager/update';
const DEPLOY = '/api/system/deployment';

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const flat = (frame: string) => frame.split('\n').map((l) => l.replace(/^\| /, '').replace(/\s*\|$/, '').trim()).join(' ').replace(/\s+/g, ' ');
const keyBar = (frame: string) => frame.split('\n').slice(-4, -1).map((l) => l.replace(/^\| /, '').replace(/\s*\|$/, '').trim()).join('  ');

// GET /api/manager/version (manager.ts:17 to :23): readManagerVersion's supported answer (selfUpdate.ts:480 to :485) with
// getManagerVersion's live fields (:322).
const versionBody = (over: Record<string, unknown> = {}) => ok({
  success: true, supported: true, bootId: 'boot-1', branch: 'main', currentCommit: 'abc1234', repoCommit: 'abc1234', buildStale: false,
  updateAvailable: true, behindBy: 2, checked: true, stamped: true, buildCommit: 'abc1234def5678abc1234def5678abc1234def56', stackPending: false,
  updateInProgress: false, lastUpdate: null, ...over,
});
// LastUpdate (selfUpdate.ts:42), written by runManagerUpdate's record (:509).
const record = (state: string, over: Record<string, unknown> = {}) => ({ opId: 'op-1', state, at: '2026-11-14T09:58:00.000Z', ...over });
// POST /api/manager/update (manager.ts:58).
const accepted = (opId = 'op-1') => ok({ success: true, opId, message: 'Manager update started' });
// GET and PUT /api/system/deployment (bots.ts:2472, :2496): getDeploymentInfo (detector.ts:206 to :212).
const deployBody = (over: Record<string, unknown> = {}) => ok({ success: true, mode: 'docker', casaosAvailable: false, autoDetected: true, forcedByEnv: false, ...over });

interface Opened {
  unmount: () => void;
  session: Session;
}
const opened: Opened[] = [];
afterEach(() => {
  for (const o of opened.splice(0)) {
    o.unmount();
    o.session.stop();
  }
});

function routes(over: { version?: Reply | (() => Reply | Promise<Reply>); deploy?: Reply | (() => Reply | Promise<Reply>) } = {}): WsFake {
  return wsFake()
    .on('GET', '/api/bots', botList([botRow()]))
    .on('GET', '/api/bots/fleet/orphan-backups', ok({ success: true, folders: [] }))
    .on('GET', VERSION, over.version ?? versionBody())
    .on('GET', DEPLOY, over.deploy ?? deployBody());
}

async function start(f: WsFake, opts: { columns?: number; rows?: number; clock?: { t: number }; startRead?: boolean } = {}) {
  const clock = opts.clock ?? { t: T0 };
  const session = new Session(f.client, () => clock.t);
  session.managerTimes = { pollMs: 40, limitMs: 15 * 60_000, readMs: 2000, deployReadMs: 2000 };
  await session.refresh();
  if (opts.startRead) await startRead(session);
  const view = render(createElement(App, { machine: 'box1', session, onHandOff: vi.fn(), now: () => clock.t, writeMode: () => undefined }));
  (view.stdout as unknown as { rows: number }).rows = opts.rows ?? 40;
  Object.defineProperty(view.stdout, 'columns', { value: opts.columns ?? 100, configurable: true });
  view.stdout.emit('resize');
  opened.push({ unmount: () => view.unmount(), session });
  await tick();
  const frame = () => view.lastFrame() ?? '';
  const press = async (...keys: string[]) => {
    for (const k of keys) {
      view.stdin.write(k);
      await tick();
    }
  };
  const untilFn = async (test: () => boolean, what: string) => {
    for (const end = Date.now() + WAIT_MS; Date.now() < end && !test();) await tick(20);
    expect(test(), what).toBe(true);
  };
  const until = (text: string) => untilFn(() => flat(frame()).includes(text), text);
  const posts = () => f.calls.filter((c) => c.method === 'POST' && c.path === UPDATE).length;
  const puts = () => f.calls.filter((c) => c.method === 'PUT' && c.path === DEPLOY).map((c) => c.body);
  const reads = (path: string) => f.calls.filter((c) => c.method === 'GET' && c.path === path).length;
  return { session, frame, press, until, untilFn, posts, puts, reads, clock, view };
}

async function toManager(f: WsFake, opts: Parameters<typeof start>[1] = {}) {
  const v = await start(f, opts);
  await v.press('m');
  await v.until('Deployment mode:');
  return v;
}

describe('m6 manager: the version read', () => {
  it('an update available shows its reason, the last update and U (index.html:1012 to :1023)', async () => {
    const f = routes({ version: versionBody({ lastUpdate: record('applied', { message: 'Updated: the manager runs abc1234.' }) }) });
    const v = await toManager(f);
    await v.until('Version: vabc1234');
    const text = flat(v.frame());
    expect(text).toContain('Update available: 2 behind');
    expect(text).toContain('Last update: applied at 2026-11-14 09:58:00 UTC: Updated: the manager runs abc1234.');
    expect(text).toContain('Deployment mode: docker (detected)');
    expect(text).toContain('CasaOS found: no');
    expect(keyBar(v.frame())).toContain('U Update manager');
    expect(keyBar(v.frame())).toContain('D Deployment mode');
  });

  it('a stale build and an unapplied stack name their reason; up to date offers no U', async () => {
    const state = { body: versionBody({ behindBy: 0, buildStale: true }) };
    const v = await toManager(routes({ version: () => state.body }));
    await v.until('Update available: build behind the checkout');
    state.body = versionBody({ behindBy: 0, buildStale: false, stackPending: true });
    await v.press('r');
    await v.until('Update available: stack not applied');
    state.body = versionBody({ behindBy: 0, updateAvailable: false });
    await v.press('r');
    await v.until('No update available.');
    expect(flat(v.frame())).toContain('Last update: none recorded.');
    expect(keyBar(v.frame())).not.toContain('U Update manager');
  });

  it('an unstamped build names the checkout', async () => {
    const v = await toManager(routes({ version: versionBody({ stamped: false, buildCommit: '', currentCommit: 'abc1234', repoCommit: 'def5678' }) }));
    await v.until('Version: unstamped build (the checkout is at def5678)');
  });

  it('supported: false shows its reason and offers no U', async () => {
    // updateBlocker's answer (selfUpdate.ts:454, its reason at :338).
    const reason = "Could not read this container's compose labels (is it compose-managed?).";
    const v = await toManager(routes({ version: ok({ success: true, supported: false, bootId: 'boot-1', reason, currentCommit: 'abc1234', stamped: true, buildCommit: 'abc1234def5678abc1234def5678abc1234def56', updateInProgress: false, lastUpdate: null }) }));
    await v.until(`Self-update is not available: ${reason}`);
    expect(flat(v.frame())).toContain('Version: vabc1234');
    expect(keyBar(v.frame())).not.toContain('U Update manager');
    await v.press('u');
    await tick(100);
    expect(flat(v.frame())).not.toContain('Update the Bot Manager now?');
  });

  it('checked: false shows the fetch error (index.html:1018)', async () => {
    const v = await toManager(routes({ version: versionBody({ checked: false, fetchError: 'fatal: unable to access the remote', behindBy: 0, updateAvailable: false }) }));
    await v.until('could not check for updates: fatal: unable to access the remote');
    expect(flat(v.frame())).not.toContain('No update available.');
  });

  it('a slow read shows the reading line until it answers', async () => {
    const h = held();
    const v = await start(routes({ version: h.answer }));
    await v.press('m');
    await v.until(READING_VERSION);
    expect(keyBar(v.frame())).not.toContain('U Update manager');
    h.release(versionBody());
    await v.until('Version: vabc1234');
    expect(flat(v.frame())).not.toContain(READING_VERSION);
  });

  it('a refused read shows the route error; no answer and a body that is not JSON show why', async () => {
    // Only getDeploymentMode's throws reach the 500 (manager.ts:21; detector.ts:140); readManagerVersion catches git's.
    const error = 'Error: The deployment mode could not be detected: docker did not answer. Nothing was decided or saved; it is retried on the next use.';
    const state: { r: Reply } = { r: refused(500, { success: false, error }) };
    const v = await toManager(routes({ version: () => state.r }));
    await v.until(`Could not read the version: ${error}`);
    state.r = noAnswer();
    await v.press('r');
    await v.until('Could not read the version: connect ECONNREFUSED 127.0.0.1:8080');
    state.r = { status: 502, ok: false, body: 'Bad Gateway' };
    await v.press('r');
    await v.until('Could not read the version: the reply was not JSON, HTTP 502');
    expect(keyBar(v.frame())).not.toContain('U Update manager');
  });

  it('a read again keeps the last update line under the reading line', async () => {
    const queue: Array<() => Reply | Promise<Reply>> = [() => versionBody({ lastUpdate: record('applied', { message: 'Updated: the manager runs abc1234.' }) })];
    const v = await toManager(routes({ version: () => (queue.shift() ?? (() => versionBody()))() }));
    await v.until('Last update: applied at 2026-11-14 09:58:00 UTC');
    const h = held();
    queue.push(h.answer);
    await v.press('r');
    await v.until(READING_VERSION);
    expect(flat(v.frame())).toContain('Last update: applied at 2026-11-14 09:58:00 UTC: Updated: the manager runs abc1234.');
    h.release(versionBody());
    await v.until('Last update: none recorded.');
  });

  it('an older answer landing last never replaces a newer one', async () => {
    const first = held();
    const queue = [first.answer, () => versionBody({ currentCommit: 'new7777' })];
    const v = await start(routes({ version: () => (queue.shift() ?? (() => versionBody()))() }));
    await v.press('m');
    await v.until(READING_VERSION);
    await v.press('r');
    await v.until('Version: vnew7777');
    first.release(versionBody({ currentCommit: 'old1111' }));
    await tick(200);
    expect(flat(v.frame())).toContain('Version: vnew7777');
    expect(flat(v.frame())).not.toContain('old1111');
  });
});

describe('m6 manager: U', () => {
  it('the dialog asks with the plan words; another key sends nothing', async () => {
    const f = routes().on('POST', UPDATE, accepted());
    const v = await toManager(f);
    await v.until('Version: vabc1234');
    await v.press('u');
    await v.until(UPDATE_QUESTION);
    expect(keyBar(v.frame())).toContain('Y Update manager');
    await v.press('n');
    await v.until('Cancelled: the manager was not updated.');
    await tick(100);
    expect(v.posts()).toBe(0);
    expect(f.opens).toBe(0);
  });

  it('Y opens /ws first, sends one POST, and a second Y sends nothing', async () => {
    const f = routes();
    const at: number[] = [];
    const h = held();
    f.on('POST', UPDATE, () => {
      at.push(f.live());
      return h.answer();
    });
    const v = await toManager(f);
    await v.until('Version: vabc1234');
    await v.press('u');
    await v.until(UPDATE_QUESTION);
    await v.press('y', 'y', 'Y');
    await v.until('Waiting for the manager to answer the update request.');
    expect(v.posts()).toBe(1);
    expect(at).toEqual([1]);
    h.release(accepted());
    await v.until('The update runs on if you leave this view.');
    await v.press('y', 'u');
    await tick(100);
    expect(v.posts()).toBe(1);
  });

  it('/ws not opening sends nothing and says so', async () => {
    const f = routes().on('POST', UPDATE, accepted());
    f.failOpen = 'connect ECONNREFUSED 127.0.0.1:8080';
    const v = await toManager(f);
    await v.until('Version: vabc1234');
    await v.press('u');
    await v.until(UPDATE_QUESTION);
    await v.press('y');
    await v.until("The manager's event stream did not open (connect ECONNREFUSED 127.0.0.1:8080), so nothing was sent.");
    expect(flat(v.frame())).toContain('Update not started');
    expect(v.posts()).toBe(0);
  });

  it('a refusal shows the route error and "Nothing was changed." (index.html:1158 to :1160)', async () => {
    // manager.ts:44: a lane would be cut short.
    const f = routes().on('POST', UPDATE, refused(409, { success: false, error: 'The manager was not updated: a fleet hand-over of mybot is running, and the update would cut it short. Update again once it ends.' }));
    const v = await toManager(f);
    await v.until('Version: vabc1234');
    await v.press('u', 'y');
    await v.until('Error: The manager was not updated: a fleet hand-over of mybot is running, and the update would cut it short. Update again once it ends.');
    await v.until('Nothing was changed.');
    expect(flat(v.frame())).toContain('Update not started');
    expect(f.live()).toBe(0);
    expect(v.session.notice).toBe('Manager update not started');
  });

  it('the casaos refusal (manager.ts:35) reads as not changed', async () => {
    const f = routes().on('POST', UPDATE, refused(400, { success: false, error: 'Updates are managed by the platform (Yundera/CasaOS).' }));
    const v = await toManager(f);
    await v.until('Version: vabc1234');
    await v.press('u', 'y');
    await v.until('Error: Updates are managed by the platform (Yundera/CasaOS).');
    await v.until('Nothing was changed.');
  });

  it('inProgress follows the running update and takes its opId from the record', async () => {
    const state = { body: versionBody() };
    const f = routes({ version: () => state.body }).on('POST', UPDATE, () => {
      state.body = versionBody({ updateInProgress: true, lastUpdate: record('running', { opId: 'op-9' }) });
      return refused(409, { success: false, inProgress: true, error: 'An update is already in progress.' });
    });
    const v = await toManager(f);
    await v.until('Version: vabc1234');
    await v.press('u', 'y');
    await v.until('An update is already running; following it.');
    await v.untilFn(() => v.session.managerFollow?.opId === 'op-9', 'opId adopted');
    f.emit('manager:log', { opId: 'op-9', line: 'Pulling origin/main', level: 'info' });
    await v.until('Pulling origin/main');
    expect(flat(v.frame())).not.toContain('Nothing was changed.');
    f.emit('manager:update-complete', { opId: 'op-9', state: 'noop', message: '[Update] Already up to date: HEAD abc1234, and every service in the stack runs its current image and config.' });
    await v.until('Nothing to apply');
    expect(v.posts()).toBe(1);
  });

  it('no answer and a body that is not JSON give the page text (index.html:1163)', async () => {
    const state: { r: Reply } = { r: noAnswer() };
    const f = routes().on('POST', UPDATE, () => state.r);
    const v = await toManager(f);
    await v.until('Version: vabc1234');
    await v.press('u', 'y');
    await v.until(UPDATE_NO_ANSWER);
    expect(flat(v.frame())).toContain('Error: connect ECONNREFUSED 127.0.0.1:8080');
    expect(flat(v.frame())).toContain('Update outcome unknown');
    expect(flat(v.frame())).not.toContain('Nothing was changed.');
    await v.press(ESC);
    await v.until('Version: vabc1234');
    state.r = { status: 200, ok: true, body: 'OK' };
    await v.press('u', 'y');
    await v.until('Error: the reply was not JSON, HTTP 200');
    await v.until(UPDATE_NO_ANSWER);
  });
});

describe('m6 manager: the update view', () => {
  async function accepted1(f: WsFake, opts: Parameters<typeof start>[1] = {}) {
    f.on('POST', UPDATE, accepted());
    const v = await toManager(f, opts);
    await v.until('Version: vabc1234');
    await v.press('u', 'y');
    await v.until('The update runs on if you leave this view.');
    return v;
  }

  it('shows the log lines of its opId only, then the restart and pending lines (index.html:1350 to :1357)', async () => {
    const f = routes();
    const v = await accepted1(f);
    f.emit('manager:log', { opId: 'op-1', line: 'Fetching origin', level: 'info' });
    f.emit('manager:log', { opId: 'op-2', line: 'A line of another update', level: 'info' });
    f.emit('bot:switch', { id: 'b1', opId: 'op-1', text: 'not ours' });
    f.emit('manager:restarting', { opId: 'op-1', target: 'def5678' });
    await v.until('Manager restarting - waiting for it to come back...');
    expect(flat(v.frame())).toContain('Restarting Bot Manager...');
    f.emit('manager:update-pending', { opId: 'op-1', message: 'The recreate is still running; this page reconnects when it finishes.' });
    await v.until('Recreate still running');
    const text = flat(v.frame());
    expect(text).toContain('Fetching origin');
    expect(text).not.toContain('A line of another update');
    expect(text).not.toContain('not ours');
  });

  it('update-complete applied, update-complete failed and update-failed end it as the page does', async () => {
    const cases: Array<[string, Record<string, unknown>, string, string]> = [
      ['manager:update-complete', { state: 'applied', message: 'Update applied without a manager restart.' }, 'Bot Manager updated', 'Update applied without a manager restart.'],
      // noopOutcome's failed state (selfUpdate.ts:535) arrives on update-complete (manager.ts:72).
      ['manager:update-complete', { state: 'failed', message: '[Update] Nothing was rebuilt: this stack runs a pulled image (smdb:latest) built from abc1234, not HEAD def5678.' }, 'Manager update did not apply', '[Update] Nothing was rebuilt'],
      ['manager:update-failed', { error: 'docker compose build exited with code 1' }, 'Manager update failed', 'Update failed: docker compose build exited with code 1'],
    ];
    for (const [type, data, toast, line] of cases) {
      const f = routes();
      const v = await accepted1(f);
      f.emit(type, { opId: 'op-1', ...data });
      await v.until(line);
      expect(v.session.notice).toBe(toast);
      expect(v.session.managerFollow?.end?.text).toBe(toast);
      expect(f.live()).toBe(0);
      for (const o of opened.splice(0)) {
        o.unmount();
        o.session.stop();
      }
    }
  });

  it('a frame that comes before the POST answer is kept until the answer names its opId', async () => {
    const f = routes();
    const h = held();
    f.on('POST', UPDATE, () => h.answer());
    const v = await toManager(f);
    await v.until('Version: vabc1234');
    await v.press('u', 'y');
    await v.until('Waiting for the manager to answer the update request.');
    f.emit('manager:update-started', { opId: 'op-1' });
    f.emit('manager:log', { opId: 'op-1', line: 'Early line of op-1', level: 'info' });
    f.emit('manager:log', { opId: 'op-0', line: 'Early line of op-0', level: 'info' });
    await tick(100);
    expect(flat(v.frame())).not.toContain('Early line');
    h.release(accepted());
    await v.until('Early line of op-1');
    expect(flat(v.frame())).not.toContain('Early line of op-0');
  });

  it('a final frame before the POST answer ends the follow with no poll timer left', async () => {
    const f = routes();
    const h = held();
    f.on('POST', UPDATE, () => h.answer());
    const v = await toManager(f);
    await v.until('Version: vabc1234');
    await v.press('u', 'y');
    await v.until('Waiting for the manager to answer the update request.');
    f.emit('manager:update-complete', { opId: 'op-1', state: 'applied', message: 'Update applied without a manager restart.' });
    await tick(50);
    h.release(accepted());
    await v.until('Update applied without a manager restart.');
    const follow = v.session.managerFollow as unknown as { end: unknown; timer: unknown };
    expect(follow.end).not.toBeNull();
    expect(follow.timer).toBeNull();
  });

  it('/ws closing then the poll: the same process with our applied record ends it', async () => {
    const state = { body: versionBody() };
    const f = routes({ version: () => state.body });
    const v = await accepted1(f);
    state.body = versionBody({ updateInProgress: true, lastUpdate: record('running') });
    f.drop('closed (code 1006)');
    await v.until("The manager's event stream closed (closed (code 1006)); reading the version until the outcome shows.");
    await tick(150);
    expect(v.session.managerFollow?.end).toBeNull();
    state.body = versionBody({ updateInProgress: false, lastUpdate: record('applied', { message: 'Update applied without a manager restart.' }) });
    await v.until('Bot Manager updated');
    expect(v.session.notice).toBe('Bot Manager updated');
  });

  it('M asks to join; D and Y answering before that read still leave the join to the read that answers', async () => {
    const running = () => versionBody({ updateInProgress: true, lastUpdate: record('running', { opId: 'op-5' }) });
    const first = held();
    const queue: Array<() => Reply | Promise<Reply>> = [first.answer];
    const f = routes({ version: () => (queue.shift() ?? running)() }).on('PUT', DEPLOY, deployBody({ mode: 'casaos', autoDetected: false }));
    const v = await start(f);
    // Above every wait in this row, so the held first read ends only by its release below.
    v.session.managerTimes.readMs = 60_000;
    await v.press('m');
    await v.until(READING_VERSION);
    await v.until('Deployment mode: docker (detected)');
    await v.press('d', DOWN, ENTER);
    await v.until(modeQuestion('casaos'));
    await v.press('y');
    await v.until('Deployment mode set to casaos.');
    await v.untilFn(() => v.session.managerFollow?.opId === 'op-5', 'the update joined');
    // The screen's own read is still held, so it stays on the main view with the follow named.
    await v.until('An update started or joined in this session is running. L shows its log.');
    const joined = v.session.managerFollow;
    first.release(running());
    // The older read answering last joins nothing again; the screen's read then shows the update view.
    await v.until('An update is running; following it.');
    await tick(200);
    expect(v.session.managerFollow).toBe(joined);
    expect(v.session.manager.joinPending).toBe(false);
    expect(f.opens).toBe(1);
    expect(v.posts()).toBe(0);
  });

  it('the 15 min limit by the clock ends it with the can\'t confirm text', async () => {
    const clock = { t: T0 };
    const state = { body: versionBody() };
    const f = routes({ version: () => state.body });
    const v = await accepted1(f, { clock });
    state.body = versionBody({ updateInProgress: true, lastUpdate: record('running') });
    f.drop('closed (code 1006)');
    clock.t = T0 + 14 * 60_000;
    await tick(200);
    expect(v.session.managerFollow?.end).toBeNull();
    clock.t = T0 + 15 * 60_000;
    await v.until(UPDATE_LIMIT);
    expect(v.session.notice).toBe('Manager update: outcome unknown');
  });

  it('the follow survives Esc and a reopened screen, which never posts again', async () => {
    const f = routes();
    const v = await accepted1(f);
    f.emit('manager:log', { opId: 'op-1', line: 'Building image', level: 'info' });
    await v.until('Building image');
    await v.press(ESC);
    await v.until('An update started or joined in this session is running. L shows its log.');
    await v.press(ESC);
    await v.untilFn(() => !flat(v.frame()).includes('Deployment mode:'), 'the list');
    await v.press('m');
    await v.until('Building image');
    f.emit('manager:log', { opId: 'op-1', line: 'Recreating', level: 'info' });
    await v.until('Recreating');
    expect(v.posts()).toBe(1);
    expect(f.opens).toBe(1);
  });

  it('an update that ended after the start read: M reads again and follows nothing', async () => {
    const state = { body: versionBody({ updateInProgress: true, lastUpdate: record('running') }) };
    const f = routes({ version: () => state.body });
    const v = await start(f, { startRead: true });
    await v.until(MANAGER_RUNNING_NOTICE);
    state.body = versionBody({ lastUpdate: record('applied', { message: 'Updated: the manager runs abc1234.' }) });
    const before = v.reads(VERSION);
    await v.press('m');
    await v.until('Last update: applied at 2026-11-14 09:58:00 UTC');
    expect(v.reads(VERSION)).toBe(before + 1);
    expect(keyBar(v.frame())).toContain('U Update manager');
    expect(flat(v.frame())).not.toContain('An update is running; following it.');
    expect(v.session.managerFollow).toBeNull();
    expect(f.opens).toBe(0);
  });

  it('at start a running update gives the list notice; M follows it with the record opId', async () => {
    const state = { body: versionBody({ updateInProgress: true, lastUpdate: record('restarting', { opId: 'op-7', target: 'def5678' }) }) };
    const f = routes({ version: () => state.body });
    const v = await start(f, { startRead: true });
    await v.until(MANAGER_RUNNING_NOTICE);
    expect(f.opens).toBe(0);
    await v.press('m');
    await v.until('An update is running; following it.');
    f.emit('manager:log', { opId: 'op-7', line: 'Line of op-7', level: 'info' });
    f.emit('manager:log', { opId: 'op-1', line: 'Line of op-1', level: 'info' });
    await v.until('Line of op-7');
    expect(flat(v.frame())).not.toContain('Line of op-1');
    state.body = versionBody({ bootId: 'boot-2', updateInProgress: false, lastUpdate: record('applied', { opId: 'op-7', message: 'Updated: the manager runs def5678.' }) });
    await v.until('Updated: the manager runs def5678.');
    expect(v.posts()).toBe(0);
  });
});

describe('m6 manager: the poll judged as resolveManagerReconnect (index.html:1091 to :1123)', () => {
  const v1 = (over: Record<string, unknown>) => ({ supported: true, bootId: 'boot-1', ...over });
  const cases: Array<[string, Record<string, unknown>, string | null, boolean | null | undefined]> = [
    ['same process, update running', v1({ updateInProgress: true, lastUpdate: record('running') }), null, undefined],
    ['same process, our noop', v1({ updateInProgress: false, lastUpdate: record('noop', { message: 'Already up to date' }) }), 'Already up to date', true],
    ['same process, our failed', v1({ updateInProgress: false, lastUpdate: record('failed', { message: 'git pull failed' }) }), 'git pull failed', false],
    ['same process, our unknown', v1({ updateInProgress: false, lastUpdate: record('unknown', { message: 'The outcome is unknown.' }) }), 'The outcome is unknown.', null],
    ['same process, our record still running but not in progress', v1({ updateInProgress: false, lastUpdate: record('restarting') }), null, undefined],
    ['same process, another update applied', v1({ updateInProgress: false, lastUpdate: record('applied', { opId: 'op-2' }) }), null, undefined],
    ['new process, ours restarting', v1({ bootId: 'boot-2', lastUpdate: record('restarting') }), null, undefined],
    ['new process, ours pending', v1({ bootId: 'boot-2', lastUpdate: record('pending') }), null, undefined],
    ['new process, ours applied', v1({ bootId: 'boot-2', lastUpdate: record('applied', { message: 'Updated: the manager runs def5678.' }) }), 'Updated: the manager runs def5678.', true],
    ['new process, ours interrupted', v1({ bootId: 'boot-2', lastUpdate: record('interrupted', { message: 'The manager restarted before the update reached the recreate step, so the update did not finish.' }) }), 'the update did not finish.', false],
    ['new process, ours not-applied', v1({ bootId: 'boot-2', lastUpdate: record('not-applied', { message: 'The manager restarted, but it runs abc1234, not the update\'s target def5678.' }) }), 'not the update\'s target', false],
    ['new process, ours unstamped', v1({ bootId: 'boot-2', lastUpdate: record('unstamped', { message: 'The manager restarted, but this build carries no commit stamp' }) }), 'carries no commit stamp', null],
    ['new process, no record', v1({ bootId: 'boot-2', lastUpdate: null }), NO_RECORD, null],
    ['new process, another update recorded', v1({ bootId: 'boot-2', lastUpdate: record('applied', { opId: 'op-2' }) }), NO_RECORD, null],
  ];
  for (const [name, body, line, ok_] of cases) {
    it(name, () => {
      const f = routes();
      const session = new Session(f.client, () => T0);
      opened.push({ unmount: () => undefined, session });
      const follow = new ManagerFollow(session, 'boot-1');
      follow.opId = 'op-1';
      follow.judge(body as ManagerVersion);
      if (line === null) {
        expect(follow.end).toBeNull();
        return;
      }
      expect(follow.end?.ok).toBe(ok_);
      expect(follow.lines.join('\n')).toContain(line);
    });
  }
});

describe('m6 manager: D deployment mode', () => {
  async function toDialog(f: WsFake, mode: 'casaos' | 'docker' = 'casaos') {
    const v = await toManager(f);
    await v.until('Deployment mode: docker (detected)');
    await v.press('d');
    await v.until('> docker (current)');
    if (mode === 'casaos') await v.press(DOWN);
    await v.press(ENTER);
    await v.until(modeQuestion(mode));
    return v;
  }

  it('the pick, the dialog with the plan facts, Y and success', async () => {
    const f = routes().on('PUT', DEPLOY, deployBody({ mode: 'casaos', autoDetected: false }));
    const v = await toDialog(f);
    expect(keyBar(v.frame())).toContain('Y Set casaos');
    await v.press('y');
    await v.until('Deployment mode set to casaos.');
    await v.until('Deployment mode: casaos (set by the operator)');
    expect(v.puts()).toEqual([{ mode: 'casaos' }]);
  });

  it('after any PUT answer the list and the version are read again at once', async () => {
    for (const reply of [deployBody({ mode: 'casaos', autoDetected: false }), refused(400, { success: false, error: 'Invalid mode' })]) {
      const f = routes().on('PUT', DEPLOY, reply);
      const v = await toDialog(f);
      const lists = v.reads('/api/bots');
      const versions = v.reads(VERSION);
      await v.press('y');
      await v.untilFn(() => v.puts().length === 1, 'the PUT');
      const end = Date.now() + 1500;
      while (Date.now() < end && !(v.reads('/api/bots') > lists && v.reads(VERSION) > versions)) await tick(20);
      expect(v.reads('/api/bots')).toBeGreaterThan(lists);
      expect(v.reads(VERSION)).toBeGreaterThan(versions);
      for (const o of opened.splice(0)) {
        o.unmount();
        o.session.stop();
      }
    }
  });

  it('another key at the dialog sends nothing', async () => {
    const f = routes().on('PUT', DEPLOY, deployBody());
    const v = await toDialog(f);
    await v.press('n');
    await v.until('Cancelled: the deployment mode was not changed.');
    await tick(100);
    expect(v.puts()).toEqual([]);
  });

  it('the 409 of a forced mode and the 500 of an unsaved mode show as the route words them', async () => {
    const texts = [
      [409, "DEPLOYMENT_MODE forces the docker mode on this manager, so the mode was not changed. Change DEPLOYMENT_MODE in the manager's environment instead."],
      [500, 'The deployment mode could not be saved, so it was not changed: EACCES: permission denied, open \'/app/data/config.json\''],
    ] as const;
    for (const [status, error] of texts) {
      const f = routes().on('PUT', DEPLOY, refused(status, { success: false, error }));
      const v = await toDialog(f);
      await v.press('y');
      await v.until(error);
      expect(flat(v.frame())).not.toContain("can't confirm");
      for (const o of opened.splice(0)) {
        o.unmount();
        o.session.stop();
      }
    }
  });

  it('the 500 after a saved mode (bots.ts:2494 to :2497) says can\'t confirm and reads the mode again', async () => {
    const state = { deploy: deployBody() };
    const f = routes({ deploy: () => state.deploy }).on('PUT', DEPLOY, () => {
      state.deploy = deployBody({ mode: 'casaos', autoDetected: false });
      return refused(500, { success: false, error: 'Error: docker did not answer' });
    });
    const v = await toDialog(f);
    const before = v.reads(DEPLOY);
    await v.press('y');
    await v.until("can't confirm whether the mode changed: Error: docker did not answer");
    await v.until('Deployment mode: casaos (set by the operator)');
    expect(v.reads(DEPLOY)).toBe(before + 1);
    expect(flat(v.frame())).not.toContain('not changed');
  });

  it('other refusals and no answer say can\'t confirm and read the mode again', async () => {
    const answers: Array<[Reply, string]> = [
      [refused(400, { success: false, error: 'Invalid mode' }), "can't confirm whether the mode changed: Invalid mode"],
      [noAnswer(), "can't confirm whether the mode changed: connect ECONNREFUSED 127.0.0.1:8080"],
      [{ status: 502, ok: false, body: 'Bad Gateway' }, "can't confirm whether the mode changed: the reply was not JSON, HTTP 502"],
    ];
    for (const [reply, text] of answers) {
      const f = routes().on('PUT', DEPLOY, () => reply);
      const v = await toDialog(f);
      const before = v.reads(DEPLOY);
      await v.press('y');
      await v.until(text);
      await v.untilFn(() => v.reads(DEPLOY) === before + 1, 'the mode read again');
      await v.until('Deployment mode: docker (detected)');
      for (const o of opened.splice(0)) {
        o.unmount();
        o.session.stop();
      }
    }
  });

  it('D is not offered when DEPLOYMENT_MODE forces the mode', async () => {
    const f = routes({ deploy: deployBody({ forcedByEnv: true, autoDetected: false }) });
    const v = await toManager(f);
    await v.until('Deployment mode: docker (forced by DEPLOYMENT_MODE)');
    expect(keyBar(v.frame())).not.toContain('D Deployment mode');
    await v.press('d');
    await tick(100);
    expect(flat(v.frame())).not.toContain('(current)');
  });

  it('a failed mode read shows its error and offers D with no mode marked current (detector.ts:125)', async () => {
    const error = 'Error: The deployment mode is undecided: config.json could not be read (Unexpected token; a copy was kept). Repair it, or replace it by setting the mode: PUT /api/system/deployment {"mode":"casaos"|"docker"}.';
    const f = routes({ deploy: refused(500, { success: false, error }) }).on('PUT', DEPLOY, deployBody({ autoDetected: false }));
    const v = await start(f);
    await v.press('m');
    await v.until(`Could not read the deployment mode: ${error}`);
    expect(flat(v.frame())).not.toContain('Deployment mode: -');
    expect(keyBar(v.frame())).toContain('D Deployment mode');
    await v.press('d');
    await v.until('> casaos');
    expect(flat(v.frame())).not.toContain('(current)');
    await v.press(DOWN, ENTER);
    await v.until(modeQuestion('docker'));
    await v.press('y');
    await v.until('Deployment mode set to docker.');
    expect(v.puts()).toEqual([{ mode: 'docker' }]);
  });

  it('a double Y sends one PUT; keys wait while it runs and Esc leaves', async () => {
    const h = held();
    const f = routes().on('PUT', DEPLOY, () => h.answer());
    const v = await toDialog(f);
    await v.press('y', 'y', 'Y', ENTER);
    await v.until('Asked the manager to set the deployment mode to casaos; waiting for the answer.');
    expect(v.puts()).toHaveLength(1);
    await v.press(ESC);
    await v.until('CasaOS found: no');
    expect(keyBar(v.frame())).not.toContain('D Deployment mode');
    await v.press('d');
    await tick(100);
    expect(v.puts()).toHaveLength(1);
    h.release(deployBody({ mode: 'casaos', autoDetected: false }));
    await v.until('Deployment mode set to casaos.');
    expect(v.puts()).toHaveLength(1);
  });
});

describe('m6 manager: columns', () => {
  for (const columns of [80, 100]) {
    it(`the list bar, the screen, both dialogs and the update view at ${columns} columns`, async () => {
      const f = routes({ version: versionBody({ lastUpdate: record('not-applied', { message: 'The manager restarted, but it runs abc1234, not the update\'s target def5678.' }) }) })
        .on('POST', UPDATE, accepted());
      const v = await start(f, { columns });
      expect(keyBar(v.frame())).toContain('M Manager');
      const width = (fr: string) => Math.max(...fr.split('\n').map((l) => l.length));
      await v.press('m');
      await v.until("Last update: not-applied at 2026-11-14 09:58:00 UTC: The manager restarted, but it runs abc1234, not the update's target def5678.");
      expect(width(v.frame())).toBeLessThan(columns);
      expect(keyBar(v.frame())).toContain('Q Quit');
      await v.press('d', DOWN, ENTER);
      await v.until(modeQuestion('casaos'));
      expect(width(v.frame())).toBeLessThan(columns);
      await v.press('n');
      await v.until('Cancelled: the deployment mode was not changed.');
      await v.press('u');
      await v.until(UPDATE_QUESTION);
      await v.press('y');
      await v.until('The update runs on if you leave this view.');
      const long = 'Step 4/12 : RUN npm ci --omit=dev && npm cache clean --force && echo a long build line that is wider than the frame';
      f.emit('manager:log', { opId: 'op-1', line: long, level: 'info' });
      await v.until(long);
      expect(width(v.frame())).toBeLessThan(columns);
      expect(keyBar(v.frame())).toContain('Esc Back');
    });
  }
});
