import { describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createElement } from 'react';
import * as ink from 'ink';
import { render } from 'ink-testing-library';
import { createApp, FrameState } from '../../src/cli/tui/app';
import { EditRequest } from '../../src/cli/tui/editbody';
import { FilesScreen, LIST_CHANGED } from '../../src/cli/tui/files';
import { editHandOff } from '../../src/cli/tui/run';
import { Session } from '../../src/cli/tui/session';
import { botList, fake, Fake, noAnswer, ok, refused, Reply } from './m2-fake';
import { botRow } from './m3-fake';

const App = createApp(ink);
vi.setConfig({ testTimeout: 30_000 });
const ESC = '\u001B';
const ENTER = '\r';
const UP = '\u001B[A';
const DOWN = '\u001B[B';
const END = '\u001B[F';
const BACKSPACE = '\u007F';
const WAIT_MS = 10_000;
const SCRIPT = path.join(__dirname, 'm3-editor.cjs');

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const flat = (frame: string) => frame.split('\n').map((l) => l.replace(/^\| /, '').replace(/\s*\|$/, '').trim()).join(' ').replace(/\s+/g, ' ');
const keyBar = (frame: string) => frame.split('\n').slice(-3, -1).map((l) => l.replace(/^\| /, '').replace(/\s*\|$/, '').trim()).join('  ');

// The bot's data folder in docker mode: getDataPath (src/git/repoManager.ts:22) under the manager's DATA_DIR.
const BASE = '/data/data/bots/b1/data';
const C = 'mybot-bot-1';
const enc = encodeURIComponent;
const LIST = (target: string, p: string) => `/api/bots/b1/fs/list?target=${enc(target)}&path=${enc(p)}`;
const READ = (target: string, p: string) => `/api/bots/b1/fs/read?target=${enc(target)}&path=${enc(p)}`;
const WRITE = '/api/bots/b1/fs/write';
const CREATE = '/api/bots/b1/fs/create';
const MKDIR = '/api/bots/b1/fs/mkdir';
const DELETE = '/api/bots/b1/fs/delete';
const RENAME = '/api/bots/b1/fs/rename';
const CONTAINERS = '/api/bots/b1/containers';

const dir = (name: string) => ({ name, isDir: true });
const file = (name: string) => ({ name, isDir: false });
// fsList success (terminal.ts:668 for the host folder, :1161 in a container).
const listed = (p: string, entries: unknown[]) => ok({ success: true, path: p, entries });
// fsRead success (terminal.ts:294): editableAnswer.
const fileBody = (p: string, body: string, eol = 'lf') => ok({ success: true, path: p, body, eol });
// fsWrite success (terminal.ts:1030 host, :1208 container).
const written = (p: string, bytes = 13) => ok({ success: true, path: p, bytes });
// unconfirmed (terminal.ts:390) with EXEC_TIMEOUT_MS 15000 (:34).
const unconfirmed = (what: string) => ok({
  success: false, unconfirmed: true,
  error: `The container did not answer within 15 s, so whether the ${what} happened could not be confirmed yet. Reload to see the result.`,
});
// refusedWhileMigrating (bots.ts:113) with MIGRATE_GATE.files (containerManager.ts:799).
const migrating = () => refused(409, { success: false, error: 'A data migration to Postgres is open on this bot, so its files cannot change until it ends; nothing was changed' });
// GET /api/bots/:id/containers success (bots.ts:942), rows {name, state, status} (dockerClient.ts:787).
const containersBody = (rows: unknown[]) => ok({ success: true, containers: rows, appName: 'mybot' });
const crow = (name: string, state = 'running') => ({ name, state, status: 'Up 2 hours' });

const SECRET = 'DISCORD_TOKEN=supersecret-123\n';
const ROOT_ENTRIES = [dir('logs'), file('config.json'), file('.env')];

function later() {
  let answer: (r: Reply) => void = () => {};
  const p = new Promise<Reply>((resolve) => {
    answer = resolve;
  });
  return { reply: () => p, answer: (r: Reply) => answer(r) };
}

function base(over: { bot?: Record<string, unknown>; containers?: Reply; root?: Reply | ((body: unknown) => Reply | Promise<Reply>) } = {}): Fake {
  return fake()
    .on('GET', '/api/bots', botList([botRow({ status: 'running', ...over.bot })]))
    .on('GET', CONTAINERS, over.containers ?? containersBody([crow(C), crow('mybot-db-1', 'exited')]))
    .on('GET', LIST('host', ''), over.root ?? listed(BASE, ROOT_ENTRIES))
    .on('GET', LIST('host', BASE), listed(BASE, ROOT_ENTRIES))
    .on('GET', LIST('host', `${BASE}/logs`), listed(`${BASE}/logs`, [file('bot.log')]))
    .on('GET', READ('host', `${BASE}/.env`), fileBody(`${BASE}/.env`, SECRET))
    .on('GET', READ('host', `${BASE}/config.json`), fileBody(`${BASE}/config.json`, '{"prefix":"!"}\n'));
}

type EditMode = 'rewrite' | 'leave' | 'fail' | 'manual';

async function start(f: Fake, opts: { columns?: number; rows?: number; edit?: EditMode; session?: Session; initial?: FrameState; env?: NodeJS.ProcessEnv; limitMs?: number } = {}) {
  const session = opts.session ?? new Session(f.client, () => 0);
  if (!opts.session) await session.refresh();
  const edits: Array<{ state: FrameState; request: EditRequest }> = [];
  const report = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'm6-report-')), 'report.json');
  const mode = opts.edit ?? 'rewrite';
  const onEdit = (state: FrameState, request: EditRequest) => {
    edits.push({ state, request });
    if (mode !== 'manual') void editHandOff(request, { enter: '', leave: '' }, { DBM_TUI_CHECK_EDITOR: JSON.stringify([process.execPath, SCRIPT, mode, report]) });
  };
  const view = render(createElement(App, {
    machine: 'box1', session, onHandOff: vi.fn(), onEdit, now: () => 0,
    filesOptions: { limitMs: opts.limitMs ?? 5000, containersLimitMs: 5000, env: opts.env ?? {} },
    ...(opts.initial ? { initial: opts.initial } : {}),
  }));
  const stdout = view.stdout as unknown as { rows: number };
  stdout.rows = opts.rows ?? 30;
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
  const type = async (text: string) => {
    for (const ch of text) await press(ch);
  };
  const until = async (test: () => boolean, what: string) => {
    const end = Date.now() + WAIT_MS;
    while (!test() && Date.now() < end) await tick(20);
    expect(test(), what).toBe(true);
  };
  const untilText = (text: string) => until(() => flat(frame()).includes(text), text);
  const count = (method: string, p: string) => f.paths().filter((x) => x === `${method} ${p}`).length;
  const sent = (method: string, p: string) => f.calls.filter((c) => c.method === method && c.path === p).map((c) => c.body);
  return { ...view, session, edits, frame, press, type, until, untilText, count, sent };
}

async function openFiles(f: Fake, opts: Parameters<typeof start>[1] = {}) {
  const v = await start(f, opts);
  await v.press(ENTER);
  await v.untilText('Name mybot');
  await v.press('f');
  await v.untilText('config.json');
  return v;
}

// The cursor starts on logs/; Down twice reaches .env.
const toEnv = [DOWN, DOWN];
const toConfig = [DOWN];

describe('m6 files: the places and their listings', () => {
  it('F opens the host place first, lists it with one read, and shows the folder on the host', async () => {
    const f = base();
    const v = await openFiles(f, { env: { HOST_DATA_DIR: '/srv/dbm' } });
    const text = flat(v.frame());
    expect(text).toContain('Files of mybot in persistent data (host)');
    expect(text).toContain(`Path: ${BASE}`);
    expect(text).toContain('Folder on the host: /srv/dbm/bots/b1/data');
    expect(text).toContain('> logs/');
    expect(text).toContain('config.json');
    expect(text).toContain('.env');
    expect(text).not.toContain('../');
    expect(keyBar(v.frame())).toContain('Enter Open folder');
    expect(v.count('GET', LIST('host', ''))).toBe(1);
    v.unmount();
  });

  it('without HOST_DATA_DIR or DATA_DIR the line names the manager data folder', async () => {
    const v = await openFiles(base());
    expect(flat(v.frame())).toContain("In the manager's data folder: bots/b1/data");
    v.unmount();
  });

  it('Files is offered on a bot started before and refused on one never started', async () => {
    const a = await start(base({ bot: { status: 'stopped', hasBeenStarted: true } }));
    await a.press(ENTER);
    await a.untilText('Name mybot');
    expect(keyBar(a.frame())).toContain('F Files');
    a.unmount();
    const b = await start(base({ bot: { status: 'created' } }));
    await b.press(ENTER);
    await b.untilText('Name mybot');
    expect(keyBar(b.frame())).not.toContain('F Files');
    await b.press('f');
    await b.untilText('mybot has never been started, so it has no files to browse yet.');
    expect(b.count('GET', LIST('host', ''))).toBe(0);
    b.unmount();
  });

  it('a refused listing shows the route text, never Empty directory', async () => {
    // localList's error (terminal.ts:659).
    const f = base({ root: ok({ success: false, error: "ENOENT: no such file or directory, open '/data/data/bots/b1/data'", path: BASE }) });
    const v = await start(f);
    await v.press(ENTER);
    await v.untilText('Name mybot');
    await v.press('f');
    await v.untilText("Could not list persistent data (host): ENOENT: no such file or directory, open '/data/data/bots/b1/data'.");
    expect(flat(v.frame())).not.toContain('Empty directory');
    v.unmount();
  });

  it('no answer, a body that is not a JSON object and the time limit each say the listing could not be read', async () => {
    const run = async (root: Reply | ((b: unknown) => Promise<Reply>), text: string, limitMs?: number) => {
      const v = await start(base({ root }), { limitMs });
      await v.press(ENTER);
      await v.untilText('Name mybot');
      await v.press('f');
      await v.untilText(text);
      expect(v.frames.map(flat).join(' ')).not.toContain('Empty directory');
      v.unmount();
    };
    await run(noAnswer(), "No answer from the manager, so persistent data (host) can't be listed (connect ECONNREFUSED 127.0.0.1:8080).");
    await run({ status: 502, ok: false, body: 'Bad Gateway' }, "can't be listed (the reply was not JSON, HTTP 502).");
    await run(() => new Promise<Reply>(() => {}), "can't be listed (the manager did not answer within 300 ms).", 300);
  });

  it('an empty folder says Empty directory', async () => {
    const v = await openFiles(base().on('GET', LIST('host', `${BASE}/logs`), listed(`${BASE}/logs`, [])));
    await v.press(ENTER);
    await v.untilText('Empty directory');
    expect(flat(v.frame())).toContain(`Path: ${BASE}/logs`);
    v.unmount();
  });

  it('an older listing that answers last never replaces the newer one', async () => {
    const slow = later();
    let n = 0;
    const f = base({ root: () => (++n === 1 ? slow.reply() : listed(BASE, [file('new.txt')])) });
    const v = await start(f);
    await v.press(ENTER);
    await v.untilText('Name mybot');
    await v.press('f');
    await v.untilText('Reading persistent data (host).');
    await v.press('f');
    await v.untilText('new.txt');
    slow.answer(listed(BASE, [file('old.txt')]));
    await tick(200);
    expect(flat(v.frame())).toContain('new.txt');
    expect(flat(v.frame())).not.toContain('old.txt');
    v.unmount();
  });

  it('Enter goes into a folder; Backspace and the ../ row go up, and the host place stops at its base', async () => {
    const f = base();
    const v = await openFiles(f);
    await v.press(ENTER);
    await v.untilText(`Path: ${BASE}/logs`);
    expect(flat(v.frame())).toContain('> ../');
    expect(flat(v.frame())).toContain('bot.log');
    await v.press(BACKSPACE);
    await v.until(() => v.count('GET', LIST('host', BASE)) === 1, 'the parent listing');
    await v.untilText('> logs/');
    await v.press(BACKSPACE);
    await tick(200);
    expect(v.count('GET', LIST('host', BASE))).toBe(1);
    await v.press(ENTER);
    await v.untilText('bot.log');
    await v.press(ENTER);
    await v.until(() => v.count('GET', LIST('host', BASE)) === 2, 'the ../ row');
    v.unmount();
  });

  it('P steps to a running container, which lists from /; a failed containers read leaves only the host', async () => {
    const f = base().on('GET', LIST(C, ''), listed('/', [dir('app'), dir('tmp')]));
    const v = await openFiles(f);
    await v.until(() => keyBar(v.frame()).includes('P Place'), 'P offered');
    await v.press('p');
    await v.untilText(`Files of mybot in container ${C}`);
    await v.untilText('app/');
    expect(flat(v.frame())).not.toContain('Folder on the host');
    expect(v.count('GET', LIST('mybot-db-1', ''))).toBe(0);
    await v.press('p');
    await v.untilText('Files of mybot in persistent data (host)');
    v.unmount();
    const g = base({ containers: refused(503, { success: false, error: 'Docker did not answer, so the containers of this bot could not be listed' }) });
    const w = await openFiles(g);
    await w.untilText('Could not list the containers of mybot: Docker did not answer, so the containers of this bot could not be listed. Only the persistent data can be browsed.');
    expect(keyBar(w.frame())).not.toContain('P Place');
    w.unmount();
  });
});

describe('m6 files: editing a file', () => {
  it('a file left unchanged in nano saves nothing', async () => {
    const f = base();
    const v = await openFiles(f, { edit: 'leave' });
    await v.press(...toConfig, ENTER);
    await v.untilText(`No change to ${BASE}/config.json.`);
    expect(v.edits).toHaveLength(1);
    expect(v.edits[0].request.name).toBe(`${BASE}/config.json`);
    expect(v.edits[0].state.screen).toBe('files');
    expect(f.paths().filter((p) => p.startsWith('PUT'))).toEqual([]);
    v.unmount();
  });

  it('changed then Y sends the edited body with the read eol and says Saved', async () => {
    const f = base()
      .on('GET', READ('host', `${BASE}/config.json`), fileBody(`${BASE}/config.json`, 'a\r\nb\r\n', 'crlf'))
      .on('PUT', WRITE, written(`${BASE}/config.json`));
    const v = await openFiles(f);
    await v.press(...toConfig, ENTER);
    await v.untilText(`Save ${BASE}/config.json in persistent data (host)? It replaces the file as it is now; a change made to it since it was read is lost.`);
    await v.press('y');
    await v.untilText(`Saved ${BASE}/config.json`);
    expect(v.sent('PUT', WRITE)).toEqual([{ target: 'host', path: `${BASE}/config.json`, body: 'edited: true\n', eol: 'crlf' }]);
    await v.until(() => v.count('GET', LIST('host', BASE)) === 1, 'the listing read again');
    v.unmount();
  });

  it('changed then N holds the edit; S then Y saves it', async () => {
    const f = base().on('PUT', WRITE, written(`${BASE}/config.json`));
    const v = await openFiles(f);
    await v.press(...toConfig, ENTER);
    await v.untilText('Y Save');
    await v.press('n');
    await v.untilText(`Edited, not saved: ${BASE}/config.json`);
    expect(keyBar(v.frame())).toContain('Enter Edit again  S Save  Esc Discard');
    expect(v.sent('PUT', WRITE)).toEqual([]);
    await v.press('s');
    await v.untilText('Y Save');
    await v.press('Y');
    await v.untilText(`Saved ${BASE}/config.json`);
    expect(v.sent('PUT', WRITE)).toHaveLength(1);
    expect(flat(v.frame())).not.toContain('Edited, not saved');
    v.unmount();
  });

  it('Enter edits the held body again; Esc asks before it discards', async () => {
    const f = base();
    const v = await openFiles(f, { edit: 'manual' });
    await v.press(...toConfig, ENTER);
    await v.until(() => v.edits.length === 1, 'the hand-off');
    v.edits[0].request.done({ ok: true, changed: true, body: 'first\n' });
    await v.untilText('Y Save');
    await v.press(ESC);
    await v.untilText('Edited, not saved');
    await v.press(ENTER);
    await v.until(() => v.edits.length === 2, 'the second hand-off');
    expect(v.edits[1].request.body).toBe('first\n');
    v.edits[1].request.done({ ok: true, changed: false, body: 'first\n' });
    await v.untilText(`No further change to ${BASE}/config.json; the edit is still held.`);
    await v.press(ESC);
    await v.untilText(`Discard the edit of ${BASE}/config.json?`);
    await v.press('x');
    await v.untilText('Edited, not saved');
    await v.press(ESC);
    await v.untilText('Y Discard');
    await v.press('y');
    await v.untilText(`Discarded the edit of ${BASE}/config.json.`);
    expect(v.session.held.files?.held).toBeNull();
    expect(f.paths().filter((p) => p.startsWith('PUT'))).toEqual([]);
    v.unmount();
  });

  it('a nano failure keeps the file as it was and holds nothing', async () => {
    const f = base();
    const v = await openFiles(f, { edit: 'fail' });
    await v.press(...toConfig, ENTER);
    await v.untilText('exited with code 1; the body was not changed.');
    expect(v.session.held.files?.held).toBeNull();
    expect(f.paths().filter((p) => p.startsWith('PUT'))).toEqual([]);
    v.unmount();
  });

  it('a refused read shows its text and opens nothing (terminal.ts:283)', async () => {
    const f = base().on('GET', READ('host', `${BASE}/config.json`), ok({ success: false, path: `${BASE}/config.json`, error: 'Binary file (not editable here)', binary: true }));
    const v = await openFiles(f);
    await v.press(...toConfig, ENTER);
    await v.untilText(`Could not open ${BASE}/config.json: Binary file (not editable here).`);
    expect(v.edits).toEqual([]);
    v.unmount();
  });

  it('the held edit outlives a remount at the same state, as after the real hand-off', async () => {
    const f = base().on('PUT', WRITE, written(`${BASE}/config.json`));
    const v = await openFiles(f, { edit: 'manual' });
    await v.press(...toConfig, ENTER);
    await v.until(() => v.edits.length === 1, 'the hand-off');
    const state = v.edits[0].state;
    v.unmount();
    v.edits[0].request.done({ ok: true, changed: true, body: 'kept\n' });
    const w = await start(f, { session: v.session, initial: state, edit: 'manual' });
    await w.untilText('Y Save');
    await w.press('y');
    await w.untilText(`Saved ${BASE}/config.json`);
    expect(w.sent('PUT', WRITE)[0]).toMatchObject({ body: 'kept\n' });
    w.unmount();
  });

  it('closing the Files screen drops the held edit', async () => {
    const v = await openFiles(base(), { edit: 'manual' });
    await v.press(...toConfig, ENTER);
    await v.until(() => v.edits.length === 1, 'the hand-off');
    v.edits[0].request.done({ ok: true, changed: true, body: 'x\n' });
    await v.untilText('Y Save');
    await v.press(ESC);
    await v.untilText('Edited, not saved');
    const screen = v.session.held.files!;
    await v.press(ESC, 'y');
    await v.untilText('Discarded the edit');
    await v.press(ESC);
    await v.untilText('Name mybot');
    expect(v.session.held.files).toBeUndefined();
    expect(screen.held).toBeNull();
    v.unmount();
  });
});

describe('m6 files: the save answers', () => {
  it('a refusal shows the route text and keeps the edit held', async () => {
    const v = await openFiles(base().on('PUT', WRITE, migrating()));
    await v.press(...toConfig, ENTER);
    await v.untilText('Y Save');
    await v.press('y');
    await v.untilText(`${BASE}/config.json: A data migration to Postgres is open on this bot, so its files cannot change until it ends; nothing was changed`);
    expect(flat(v.frame())).toContain(`Edited, not saved: ${BASE}/config.json`);
    expect(v.frames.map(flat).join(' ')).not.toContain('Saved ');
    v.unmount();
  });

  it("unconfirmed and no answer say can't confirm and keep the edit under a can't-confirm line", async () => {
    const a = await openFiles(base().on('PUT', WRITE, unconfirmed('save')));
    await a.press(...toConfig, ENTER);
    await a.untilText('Y Save');
    await a.press('y');
    await a.untilText(`Can't confirm the save of ${BASE}/config.json: The container did not answer within 15 s, so whether the save happened could not be confirmed yet.`);
    expect(flat(a.frame())).toContain(`Edited; whether it was saved can't be confirmed: ${BASE}/config.json`);
    expect(a.frames.map(flat).join(' ')).not.toContain('Saved ');
    a.unmount();
    const b = await openFiles(base().on('PUT', WRITE, noAnswer()));
    await b.press(...toConfig, ENTER);
    await b.untilText('Y Save');
    await b.press('y');
    await b.untilText(`No answer from the manager (connect ECONNREFUSED 127.0.0.1:8080), so the save of ${BASE}/config.json can't be confirmed. Refresh before trying again.`);
    expect(flat(b.frame())).toContain("whether it was saved can't be confirmed");
    b.unmount();
  });

  it('a body that is not a JSON object is no answer', async () => {
    const v = await openFiles(base().on('PUT', WRITE, { status: 502, ok: false, body: 'Bad Gateway' }));
    await v.press(...toConfig, ENTER);
    await v.untilText('Y Save');
    await v.press('y');
    await v.untilText(`No answer from the manager (the reply was not JSON, HTTP 502), so the save of ${BASE}/config.json can't be confirmed.`);
    v.unmount();
  });
});

describe('m6 files: new file, new folder, rename, delete', () => {
  it('N creates a file in the listed folder and reads the listing again', async () => {
    // fsCreate success (terminal.ts:1096 host).
    const f = base().on('POST', CREATE, ok({ success: true, path: `${BASE}/notes.txt` }));
    const v = await openFiles(f);
    await v.press('n');
    await v.untilText(`New file name in ${BASE} (persistent data (host)):`);
    await v.type('notes.txt');
    await v.press(ENTER);
    await v.untilText(`Created ${BASE}/notes.txt`);
    expect(v.sent('POST', CREATE)).toEqual([{ target: 'host', path: `${BASE}/notes.txt` }]);
    await v.until(() => v.count('GET', LIST('host', BASE)) === 1, 'the listing read again');
    v.unmount();
  });

  it('N answered exists, unconfirmed, or Esc', async () => {
    const f = base().on('POST', CREATE, ok({ success: false, exists: true, error: `${BASE}/a already exists; nothing was changed` }));
    const v = await openFiles(f);
    await v.press('n');
    await v.type('a');
    await v.press(ENTER);
    await v.untilText(`${BASE}/a already exists; nothing was changed`);
    await v.press('n', 'b', ESC);
    await v.untilText('Nothing was created.');
    expect(v.sent('POST', CREATE)).toHaveLength(1);
    v.unmount();
    const w = await openFiles(base().on('POST', CREATE, unconfirmed('create')));
    await w.press('n');
    await w.type('c');
    await w.press(ENTER);
    await w.untilText(`Can't confirm the creation of ${BASE}/c: The container did not answer within 15 s`);
    w.unmount();
  });

  it('K asks for a folder (fsMkdir, terminal.ts:1105); a success never says Created, and a refusal shows its text', async () => {
    const f = base().on('POST', MKDIR, ok({ success: true, path: `${BASE}/cache` }));
    const v = await openFiles(f);
    await v.press('k');
    await v.untilText(`New folder name in ${BASE} (persistent data (host)):`);
    await v.type('cache');
    await v.press(ENTER);
    // The answer is the same whether the folder was made or the bot made it first (terminal.ts:600, :1233 to :1235).
    await v.untilText(`The folder ${BASE}/cache is there now`);
    expect(v.frames.map(flat).join(' ')).not.toContain('Created');
    expect(v.sent('POST', MKDIR)).toEqual([{ target: 'host', path: `${BASE}/cache` }]);
    v.unmount();
    // mkdirInScope on the host (terminal.ts:621): the error code, then the path asked for.
    const w = await openFiles(base().on('POST', MKDIR, ok({ success: false, error: `EACCES: cannot create directory ${BASE}/x` })));
    await w.press('k');
    await w.type('x');
    await w.press(ENTER);
    await w.untilText(`EACCES: cannot create directory ${BASE}/x`);
    w.unmount();
  });

  it('K on names that reach a listed folder says the folder is there, never Created (mkdir -p, terminal.ts:1233)', async () => {
    for (const typed of ['logs', 'logs/', './logs']) {
      const f = base().on('POST', MKDIR, (b) => ok({ success: true, path: (b as { path: string }).path }));
      const v = await openFiles(f);
      await v.press('k');
      await v.type(typed);
      await v.press(ENTER);
      await v.until(() => v.sent('POST', MKDIR).length === 1, 'one mkdir');
      const sentPath = (v.sent('POST', MKDIR)[0] as { path: string }).path;
      await v.untilText(`The folder ${sentPath} is there now`);
      expect(v.frames.map(flat).join(' ')).not.toContain('Created');
      v.unmount();
    }
  });

  it('N and K with no answer say the creation cannot be confirmed', async () => {
    for (const [k, route] of [['n', CREATE], ['k', MKDIR]] as const) {
      const v = await openFiles(base().on('POST', route, noAnswer()));
      await v.press(k);
      await v.type('fresh');
      await v.press(ENTER);
      await v.untilText(`No answer from the manager (connect ECONNREFUSED 127.0.0.1:8080), so the creation of ${BASE}/fresh can't be confirmed.`);
      expect(v.frames.map(flat).join(' ')).not.toContain(`Created ${BASE}/fresh`);
      v.unmount();
    }
  });

  it('R renames the picked row', async () => {
    // fsRename success (terminal.ts:1139 host).
    const f = base().on('POST', RENAME, ok({ success: true, from: `${BASE}/config.json`, to: `${BASE}/config.json.bak` }));
    const v = await openFiles(f);
    await v.press(...toConfig, 'r');
    await v.untilText(`Rename ${BASE}/config.json to:`);
    expect(flat(v.frame())).toContain('[config.json');
    await v.press(END);
    await v.type('.bak');
    await v.press(ENTER);
    await v.untilText(`Renamed ${BASE}/config.json to ${BASE}/config.json.bak`);
    expect(v.sent('POST', RENAME)).toEqual([{ target: 'host', from: `${BASE}/config.json`, to: `${BASE}/config.json.bak` }]);
    v.unmount();
  });

  it('R answered exists asks; Y sends overwrite, any other key renames nothing', async () => {
    // localRename (terminal.ts:1136).
    const exists = ok({ success: false, exists: true, error: `${BASE}/.env already exists; nothing was renamed` });
    const f = base().on('POST', RENAME, (b) => ((b as { overwrite?: boolean }).overwrite ? ok({ success: true, from: `${BASE}/config.json`, to: `${BASE}/.env` }) : exists));
    const v = await openFiles(f);
    await v.press(...toConfig, 'r');
    for (let i = 0; i < 11; i++) await v.press(BACKSPACE);
    await v.type('.env');
    await v.press(ENTER);
    await v.untilText(`${BASE}/.env already exists in persistent data (host). Replace it with ${BASE}/config.json? The current ${BASE}/.env will be lost.`);
    await v.press('y');
    await v.untilText(`Renamed ${BASE}/config.json to ${BASE}/.env`);
    expect(v.sent('POST', RENAME)).toEqual([
      { target: 'host', from: `${BASE}/config.json`, to: `${BASE}/.env` },
      { target: 'host', from: `${BASE}/config.json`, to: `${BASE}/.env`, overwrite: true },
    ]);
    v.unmount();
    const g = base().on('POST', RENAME, exists);
    const w = await openFiles(g);
    await w.press(...toConfig, 'r');
    for (let i = 0; i < 11; i++) await w.press(BACKSPACE);
    await w.type('.env');
    await w.press(ENTER);
    await w.untilText('Y Replace');
    await w.press('n');
    await w.untilText('Nothing was renamed.');
    expect(w.sent('POST', RENAME)).toHaveLength(1);
    w.unmount();
  });

  it('R refused or unanswered never says renamed', async () => {
    const run = async (answer: Reply, text: string) => {
      const v = await openFiles(base().on('POST', RENAME, answer));
      await v.press(...toConfig, 'r', END);
      await v.type('2');
      await v.press(ENTER);
      await v.untilText(text);
      expect(v.frames.map(flat).join(' ')).not.toContain('Renamed');
      expect(v.sent('POST', RENAME)).toHaveLength(1);
      v.unmount();
    };
    // localRename refusing a folder target (terminal.ts:1135) and the migration gate (bots.ts:1530).
    await run(ok({ success: false, error: `${BASE}/config.json2 is a folder; nothing was renamed` }), `${BASE}/config.json2 is a folder; nothing was renamed`);
    await run(migrating(), 'A data migration to Postgres is open on this bot, so its files cannot change until it ends; nothing was changed');
    await run(noAnswer(), `No answer from the manager (connect ECONNREFUSED 127.0.0.1:8080), so the rename of ${BASE}/config.json can't be confirmed.`);
  });

  it('a rename stopped at its bound says it cannot be confirmed (terminal.ts:1276)', async () => {
    const f = base().on('POST', RENAME, ok({ success: false, error: 'The rename was stopped after 12 s, so whether it happened could not be confirmed. Reload to see the result.' }));
    const v = await openFiles(f);
    await v.press(...toConfig, 'r', END);
    await v.type('2');
    await v.press(ENTER);
    await v.untilText(`Can't confirm the rename of ${BASE}/config.json to ${BASE}/config.json2: The rename was stopped after 12 s`);
    v.unmount();
  });

  it('X deletes after Y: deleted, nothing there, cancelled', async () => {
    // fsDelete answers (terminal.ts:1120, :1111).
    let removed = true;
    const f = base().on('POST', DELETE, () => ok({ success: true, path: `${BASE}/config.json`, removed }));
    const v = await openFiles(f);
    await v.press(...toConfig, 'x');
    await v.untilText(`Delete ${BASE}/config.json in persistent data (host)? This cannot be undone.`);
    await v.press('y');
    await v.untilText(`Deleted ${BASE}/config.json`);
    removed = false;
    await v.until(() => v.count('GET', LIST('host', BASE)) === 1, 'the listing read again');
    await v.untilText('> config.json');
    await v.press('x', 'y');
    await v.untilText(`Nothing was at ${BASE}/config.json, so nothing was deleted`);
    await v.until(() => v.count('GET', LIST('host', BASE)) === 2, 'the listing read again');
    await v.untilText('> config.json');
    await v.press('x', 'n');
    await v.untilText('Cancelled: nothing was sent.');
    expect(v.sent('POST', DELETE)).toEqual([{ target: 'host', path: `${BASE}/config.json` }, { target: 'host', path: `${BASE}/config.json` }]);
    v.unmount();
  });

  it('X on a folder says the whole folder goes (localDelete removes the tree, terminal.ts:1119)', async () => {
    const f = base().on('POST', DELETE, ok({ success: true, path: `${BASE}/logs`, removed: true }));
    const v = await openFiles(f);
    await v.press('x');
    await v.untilText(`Delete the folder ${BASE}/logs and everything in it, in persistent data (host)? This cannot be undone.`);
    await v.press('y');
    await v.untilText(`Deleted ${BASE}/logs`);
    expect(v.sent('POST', DELETE)).toEqual([{ target: 'host', path: `${BASE}/logs` }]);
    v.unmount();
  });

  it("X answered by the stop text, still running, a refusal or no answer never says deleted", async () => {
    const run = async (answer: Reply, text: string) => {
      const v = await openFiles(base().on('GET', LIST(C, ''), listed('/', [file('x.log')])).on('POST', DELETE, answer));
      await v.until(() => keyBar(v.frame()).includes('P Place'), 'P offered');
      await v.press('p');
      await v.untilText('x.log');
      await v.press('x');
      await v.untilText(`Delete /x.log in container ${C}? This cannot be undone.`);
      await v.press('y');
      await v.untilText(text);
      expect(v.frames.map(flat).join(' ')).not.toContain('Deleted /x.log');
      expect(v.sent('POST', DELETE)).toEqual([{ target: C, path: '/x.log' }]);
      v.unmount();
    };
    await run(ok({ success: false, error: 'The delete of /x.log was stopped after 12 s; part of it may already be gone. Reload to see what remains.' }),
      "Can't confirm the delete of /x.log: The delete of /x.log was stopped after 12 s; part of it may already be gone.");
    await run(ok({ success: false, error: 'An earlier delete or rename of /x.log may still be running in the container. Reload to see its result before trying again.' }),
      'An earlier delete or rename of /x.log may still be running in the container.');
    await run(unconfirmed('delete'), "Can't confirm the delete of /x.log: The container did not answer within 15 s");
    await run(ok({ success: false, error: 'Container does not belong to this bot' }), 'Container does not belong to this bot');
    await run(noAnswer(), "No answer from the manager (connect ECONNREFUSED 127.0.0.1:8080), so the delete of /x.log can't be confirmed.");
  });
});

describe('m6 files: one write at a time, the picked row, the relist rule', () => {
  it('a second press while a write runs sends nothing', async () => {
    const slow = later();
    const f = base().on('POST', DELETE, () => slow.reply());
    const v = await openFiles(f);
    await v.press(...toConfig, 'x', 'y');
    await v.untilText(`Deleting ${BASE}/config.json in persistent data (host).`);
    await v.press('x', 'y', 'r', 'n', 'k', ENTER, 'y');
    await tick(200);
    expect(v.sent('POST', DELETE)).toHaveLength(1);
    expect(f.paths().filter((p) => p.startsWith('POST') && !p.includes('delete'))).toEqual([]);
    slow.answer(ok({ success: true, path: `${BASE}/config.json`, removed: true }));
    await v.untilText(`Deleted ${BASE}/config.json`);
    v.unmount();
  });

  it('a save holds the keys, Esc included, until it answers', async () => {
    const slow = later();
    const f = base().on('PUT', WRITE, () => slow.reply());
    const v = await openFiles(f);
    await v.press(...toConfig, ENTER);
    await v.untilText('Y Save');
    await v.press('y');
    await v.untilText(`Saving ${BASE}/config.json in persistent data (host).`);
    await v.press(ESC, 's', 'y');
    await tick(200);
    expect(flat(v.frame())).toContain('Waiting for the manager');
    expect(v.sent('PUT', WRITE)).toHaveLength(1);
    slow.answer(written(`${BASE}/config.json`));
    await v.untilText(`Saved ${BASE}/config.json`);
    v.unmount();
  });

  it('a second Files screen opened during a write waits for it', async () => {
    const slow = later();
    const f = base().on('POST', CREATE, () => slow.reply());
    const v = await openFiles(f);
    await v.press('n');
    await v.type('a.txt');
    await v.press(ENTER);
    await v.untilText('Waiting for the manager Esc Back');
    await v.press(ESC);
    await v.untilText('Name mybot');
    await v.press('f');
    await v.untilText('config.json');
    expect(flat(v.frame())).toContain(`Creating the file ${BASE}/a.txt`);
    await v.press('n', 'b', ENTER);
    expect(v.sent('POST', CREATE)).toHaveLength(1);
    slow.answer(ok({ success: true, path: `${BASE}/a.txt` }));
    await v.untilText(`mybot: Created ${BASE}/a.txt`);
    v.unmount();
  });

  it('a re-read that moves another row under the cursor makes the press send nothing until Up or Down picks', async () => {
    const f = base()
      .on('GET', LIST('host', BASE), listed(BASE, [dir('logs'), file('aaa.txt'), file('config.json'), file('.env')]))
      .on('POST', DELETE, ok({ success: true, path: `${BASE}/aaa.txt`, removed: true }));
    const v = await openFiles(f);
    await v.press(...toConfig);
    await v.untilText('> config.json');
    await v.press('f');
    await v.untilText('aaa.txt');
    expect(flat(v.frame())).not.toContain('> aaa.txt');
    expect(keyBar(v.frame())).not.toContain('X Delete');
    await v.press('x');
    await v.untilText(LIST_CHANGED);
    await v.press('x', ENTER, 'r');
    await tick(150);
    expect(flat(v.frame())).not.toContain('Delete ');
    expect(v.edits).toEqual([]);
    await v.press(DOWN, UP);
    await v.untilText('> aaa.txt');
    await v.press('x');
    await v.untilText(`Delete ${BASE}/aaa.txt in persistent data (host)?`);
    await v.press('y');
    await v.untilText(`Deleted ${BASE}/aaa.txt`);
    expect(v.sent('POST', DELETE)).toEqual([{ target: 'host', path: `${BASE}/aaa.txt` }]);
    v.unmount();
  });

  it('a re-read landing while the delete question is open leaves the question and its path as they were', async () => {
    const f = base()
      .on('GET', LIST('host', BASE), listed(BASE, [file('zzz')]))
      .on('POST', DELETE, ok({ success: true, path: `${BASE}/config.json`, removed: true }));
    const v = await openFiles(f);
    await v.press(...toConfig, 'x');
    await v.untilText(`Delete ${BASE}/config.json`);
    const screen = v.session.held.files as unknown as { list: () => Promise<void> };
    await screen.list();
    await tick(100);
    expect(flat(v.frame())).toContain(`Delete ${BASE}/config.json`);
    await v.press('y');
    await v.untilText(`Deleted ${BASE}/config.json`);
    expect(v.sent('POST', DELETE)).toEqual([{ target: 'host', path: `${BASE}/config.json` }]);
    v.unmount();
  });

  it('the listing is read again only while the screen shows the folder the action ran in', async () => {
    const slow = later();
    const f = base().on('POST', CREATE, () => slow.reply());
    const v = await openFiles(f);
    await v.press(ENTER);
    await v.untilText('bot.log');
    await v.press('n');
    await v.type('n.txt');
    await v.press(ENTER);
    await v.untilText('Esc Back');
    await v.press(ESC);
    await v.untilText('Name mybot');
    await v.press('f');
    await v.untilText('config.json');
    const logsReads = v.count('GET', LIST('host', `${BASE}/logs`));
    const rootReads = v.count('GET', LIST('host', ''));
    slow.answer(ok({ success: true, path: `${BASE}/logs/n.txt` }));
    await v.untilText(`Created ${BASE}/logs/n.txt`);
    await tick(200);
    expect(v.count('GET', LIST('host', `${BASE}/logs`))).toBe(logsReads);
    expect(v.count('GET', LIST('host', ''))).toBe(rootReads);
    expect(v.count('GET', LIST('host', BASE))).toBe(0);
    v.unmount();
  });
});

describe('m6 files: no file body outside nano', () => {
  it('the body and the edited text never reach a frame, a notice or the session', async () => {
    const f = base().on('PUT', WRITE, (b) => ((b as { body: string }).body ? unconfirmed('save') : migrating()));
    const v = await openFiles(f, { edit: 'manual' });
    await v.press(...toEnv, ENTER);
    await v.until(() => v.edits.length === 1, 'the hand-off');
    expect(v.edits[0].request.body).toBe(SECRET);
    v.edits[0].request.done({ ok: true, changed: true, body: 'DISCORD_TOKEN=othersecret-456\n' });
    await v.untilText('Y Save');
    await v.press('y');
    await v.untilText("Can't confirm the save of");
    await v.press('s', 'n', ESC, 'n', ENTER);
    await v.until(() => v.edits.length === 2, 'the second hand-off');
    v.edits[1].request.done({ ok: false, text: 'nano exited with code 1; the body was not changed.' });
    await v.untilText('nano exited with code 1');
    await v.press(ESC, 'y');
    await v.untilText('Discarded the edit');
    await v.press(ESC);
    await v.untilText('Name mybot');
    const all = v.frames.join('\n');
    expect(all).not.toContain('supersecret');
    expect(all).not.toContain('othersecret');
    expect(String(v.session.notice ?? '')).not.toContain('secret');
    v.unmount();
  });
});

describe('m6 files: 80 and 100 columns', () => {
  it('rows, the key bar, the edit and dialogs stay inside 80 columns, whole', async () => {
    const long = `a-very-long-file-name-${'x'.repeat(90)}.json`;
    const f = base({ root: listed(BASE, [dir('logs'), file(long), file('config.json')]) });
    const v = await openFiles(f, { columns: 80, env: { HOST_DATA_DIR: `/srv/${'d'.repeat(70)}` } });
    for (const l of v.frame().split('\n')) expect(l.length).toBeLessThanOrEqual(80);
    expect(flat(v.frame()).replace(/ /g, '')).toContain(long);
    const bar = keyBar(v.frame());
    for (const k of ['Up/Down Pick', 'Enter Open folder', 'N New file', 'K New folder', 'G Go to', 'F Refresh', 'Esc Back', 'Q Quit']) expect(bar).toContain(k);
    await v.press(DOWN, 'x');
    await v.untilText('This cannot be undone.');
    for (const l of v.frame().split('\n')) expect(l.length).toBeLessThanOrEqual(80);
    expect(flat(v.frame()).replace(/ /g, '')).toContain(`${BASE}/${long}`);
    await v.press('n');
    await v.press(DOWN, ENTER);
    await v.untilText('Y Save');
    for (const l of v.frame().split('\n')) expect(l.length).toBeLessThanOrEqual(80);
    await v.press('n');
    await v.untilText('Edited, not saved');
    expect(keyBar(v.frame())).toContain('Enter Edit again  S Save  Esc Discard');
    v.unmount();
  });

  it('the bot bar offers F Files whole at 80 and 100 columns', async () => {
    for (const columns of [80, 100]) {
      const v = await start(base(), { columns });
      await v.press(ENTER);
      await v.untilText('Name mybot');
      for (const l of v.frame().split('\n')) expect(l.length).toBeLessThanOrEqual(columns);
      expect(keyBar(v.frame())).toContain('F Files');
      v.unmount();
    }
  });
});
