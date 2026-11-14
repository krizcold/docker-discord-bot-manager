import { describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createElement } from 'react';
import * as ink from 'ink';
import { render } from 'ink-testing-library';
import { createApp, FrameState, keyLines } from '../../src/cli/tui/app';
import { EditRequest } from '../../src/cli/tui/editbody';
import { editHandOff } from '../../src/cli/tui/run';
import { Session } from '../../src/cli/tui/session';
import { parseConfig, serializeConfig, ConfigOp } from '../../src/config/configSerializer';
import {
  botList, configSaved, created, envSaved, fake, Fake, gitSource, NAME_PATH, nameOk, noAnswer, ok, refused, repoEnvs, sourceList,
} from './m2-fake';
import { botRow } from './m3-fake';

const App = createApp(ink);
vi.setConfig({ testTimeout: 20_000 });
const ESC = '\u001B';
const ENTER = '\r';
const TAB = '\t';
const RIGHT = '\u001B[C';
const CTRL = (c: string) => String.fromCharCode(c.charCodeAt(0) - 96);
const CONFIG = '/api/bots/b1/config';
const SCRIPT = path.join(__dirname, 'm3-editor.cjs');

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const flat = (frame: string) => frame.split('\n').map((l) => l.replace(/^\| /, '').replace(/\s*\|$/, '').trim()).join(' ').replace(/\s+/g, ' ');
const keyBar = (frame: string) => frame.split('\n').at(-2) ?? '';
const tabs = (n: number) => Array(n).fill(TAB) as string[];

const INACTIVE = "Not used: this deployment removes the bot's own login gateway (Auth: Auto). The gateway and this file stay when Auth is Public (`bots web-auth <id> public`) or when BOT_PORT_BIND is off loopback.";

// One file of GET /api/bots/:id/config (bots.ts:1387): buildBotConfigList (src/env/envList.ts:400) plus format,
// manifest and parsed.
const file = (over: Record<string, unknown>) => ({ path: '/app/config.json', body: '', enabled: true, format: 'json', manifest: null, parsed: null, ...over });
const SAVED = file({ path: '/app/config.json', body: '{\n  "prefix": "!"\n}\n', readOnly: true });
const TEMPLATE = file({ path: '/app/settings.yml', body: 'a: 1\n', fromTemplate: true, repoReadOnly: false, format: 'yaml' });
const GATEWAY = file({ path: '/app/gateway.conf', body: 'x\n', inactive: INACTIVE, format: 'conf' });
const configBody = (files: unknown[], over: Record<string, unknown> = {}) => ok({
  success: true, files, storeBroken: false, corruptCopies: [], secretKeyProblem: null, ...over,
});
// PUT /api/bots/:id/config (bots.ts:1430).
const savedAnswer = (over: Record<string, unknown> = {}) => ok({ success: true, needsUpdate: false, mountsUnknown: false, ...over });
// refusedWhileMigrating (bots.ts:113) with MIGRATE_GATE.files (containerManager.ts:799).
const migrating = () => refused(409, { success: false, error: 'A data migration to Postgres is open on this bot, so its files cannot change until it ends; nothing was changed' });

function base(files: unknown[] = [SAVED, TEMPLATE, GATEWAY], over: Record<string, unknown> = {}): Fake {
  return fake()
    .on('GET', '/api/bots', botList([botRow(over)]))
    .on('GET', CONFIG, configBody(files))
    .on('POST', '/api/config/serialize', (b) => {
      const { format, body, ops } = b as { format: 'json'; body: string; ops: ConfigOp[] };
      return ok({ success: true, ...serializeConfig(format, body, ops) });
    })
    .on('POST', '/api/config/parse', (b) => {
      const { format, body } = b as { format: 'json'; body: string };
      return ok({ success: true, ...parseConfig(format, body) });
    });
}

function editorEnv(mode: string) {
  const report = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'm3-report-')), 'report.json');
  return { env: { DBM_TUI_CHECK_EDITOR: JSON.stringify([process.execPath, SCRIPT, mode, report]) }, report };
}

async function start(f: Fake, opts: { rows?: number; columns?: number; editMode?: string; session?: Session; initial?: FrameState } = {}) {
  const session = opts.session ?? new Session(f.client, () => 0);
  if (!opts.session) await session.refresh();
  const edits: Array<{ state: FrameState; request: EditRequest }> = [];
  const editor = editorEnv(opts.editMode ?? 'rewrite');
  const onEdit = (state: FrameState, request: EditRequest) => {
    edits.push({ state, request });
    void editHandOff(request, { enter: '', leave: '' }, editor.env);
  };
  const view = render(createElement(App, {
    machine: 'box1', session, onHandOff: vi.fn(), onEdit, now: () => 0, wizardOptions: { secret: () => 'x'.repeat(64) }, ...(opts.initial ? { initial: opts.initial } : {}),
  }));
  const stdout = view.stdout as unknown as { rows: number; columns: number };
  stdout.rows = opts.rows ?? 60;
  if (opts.columns) Object.defineProperty(view.stdout, 'columns', { value: opts.columns, configurable: true });
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
  const type = async (text: string) => {
    for (const ch of text) await press(ch);
  };
  return { ...view, session, frame, press, until, type, edits, report: editor.report };
}

async function openConfig(f: Fake, opts: Parameters<typeof start>[1] = {}) {
  const v = await start(f, opts);
  await v.press(ENTER);
  await v.until('Name mybot');
  await v.press('c');
  await v.until('Config Files: mybot');
  await v.until('Esc Cancel');
  return v;
}

const putFiles = (f: Fake) => f.calls.filter((c) => c.method === 'PUT' && c.path === CONFIG).map((c) => (c.body as { files: unknown[] }).files);

// Focus order: per file its line, path, Writable and body; then Add config file and Save.
const TO_SAVE = tabs(40);

describe('m3 config editor: reading', () => {
  it('C opens the files of a stopped bot with path, Writable, on/off, body, the template and inactive notes', async () => {
    const f = base();
    const v = await openConfig(f);
    const text = flat(v.frame());
    expect(f.paths()).toContain('GET /api/bots/b1/config');
    expect(text).toContain('Files bind-mounted into the container. Saved changes are applied the next time the bot starts');
    expect(text).toContain('[x] /app/config.json');
    expect(text).toContain('Path [/app/config.json');
    expect(text).toContain('[ ] Writable Body 3 lines; Enter edits it in nano');
    expect(text).toContain('[x] /app/settings.yml Repo default, not saved yet: Save keeps it only if you change it.');
    expect(text).toContain('[x] Writable Body 1 line; Enter edits it in nano');
    expect(text).toContain(INACTIVE);
    v.unmount();
  });

  it('a running bot offers no C, and C says why and calls nothing', async () => {
    const f = base(undefined, { status: 'running' });
    const v = await start(f);
    await v.press(ENTER);
    await v.until('Name mybot');
    expect(keyBar(v.frame())).not.toContain('C Config');
    await v.press('c');
    await v.until('Stop the bot to edit config files.');
    expect(f.paths()).not.toContain('GET /api/bots/b1/config');
    v.unmount();
  });

  it('a refused read shows the route text; no answer and a reply that is not JSON say can not read', async () => {
    const f = base().on('GET', CONFIG, refused(404, { success: false, error: 'Bot not found' }));
    const v = await start(f);
    await v.press(ENTER, 'c');
    await v.until('Bot not found');
    expect(flat(v.frame())).not.toContain('Save');
    await v.press(ESC);
    await v.until('Name mybot');
    v.unmount();
    const g = base().on('GET', CONFIG, noAnswer());
    const w = await start(g);
    await w.press(ENTER, 'c');
    await w.until("can't read the config files of mybot: the manager did not answer (connect ECONNREFUSED 127.0.0.1:8080).");
    w.unmount();
    const h = base().on('GET', CONFIG, { status: 502, ok: false, body: 'Bad Gateway' });
    const x = await start(h);
    await x.press(ENTER, 'c');
    await x.until("can't read the config files of mybot: the manager did not answer (the reply was not JSON, HTTP 502).");
    x.unmount();
  });

  it('shows the store banners of configFiles.json', async () => {
    const f = base().on('GET', CONFIG, configBody([SAVED], { storeBroken: true, corruptCopies: ['configFiles.json.corrupt-1'], secretKeyProblem: 'the key file is empty' }));
    const v = await openConfig(f);
    const text = flat(v.frame());
    expect(text).toContain('Secrets cannot be saved: the key file is empty. Fix the key file and restart the manager.');
    expect(text).toContain('configFiles.json cannot be read, so saves are refused until it is repaired or replaced.');
    expect(text).toContain('Copies of damaged configFiles.json kept beside it: configFiles.json.corrupt-1.');
    v.unmount();
  });
});

describe('m3 config editor: fields and save', () => {
  it('an untouched save sends the saved file with its mode, skips the repo default, and says Saved; the bot list is read again', async () => {
    const f = base().on('PUT', CONFIG, savedAnswer());
    const v = await openConfig(f);
    const reads = f.paths().filter((p) => p === 'GET /api/bots').length;
    await v.press(...TO_SAVE, ENTER);
    await v.until('Config files of mybot saved. Press Start (or Build, then Start; Install & Run if the bot was never started) to apply.');
    await v.until('Name mybot');
    expect(putFiles(f)).toEqual([[
      { path: '/app/config.json', body: '{\n  "prefix": "!"\n}\n', readOnly: true, enabled: true },
      { path: '/app/gateway.conf', body: 'x\n', enabled: true },
    ]]);
    for (let i = 0; i < 50 && f.paths().filter((p) => p === 'GET /api/bots').length === reads; i++) await tick(20);
    expect(f.paths().filter((p) => p === 'GET /api/bots').length).toBeGreaterThan(reads);
    v.unmount();
  });

  it('the path, Writable and on/off change what is sent; a changed repo default is sent', async () => {
    const f = base().on('PUT', CONFIG, savedAnswer({ needsUpdate: true }));
    const v = await openConfig(f);
    await v.press(TAB);
    await v.type('5');
    await v.press(TAB, ' ');
    expect(flat(v.frame())).toContain("Mount the file writable so the bot can change it");
    await v.press(TAB, TAB, TAB, TAB, ' ');
    expect(flat(v.frame())).toContain("Untouched, the file keeps the mode the repo's compose gives it (writable).");
    await v.press(TAB, TAB, ' ');
    expect(flat(v.frame())).toContain('[ ] /app/gateway.conf');
    await v.press(...TO_SAVE, ENTER);
    await v.until('Config files of mybot saved. Press Build, then Start (Install & Run if the bot was never started), to apply: files were added, removed, turned on or off, or changed mode.');
    expect(putFiles(f)).toEqual([[
      { path: '/app/config.json5', body: '{\n  "prefix": "!"\n}\n', readOnly: false, enabled: true },
      { path: '/app/settings.yml', body: 'a: 1\n', readOnly: true, enabled: true },
      { path: '/app/gateway.conf', body: 'x\n', enabled: false },
    ]]);
    v.unmount();
  });

  it('Ctrl+D removes a file from what is sent', async () => {
    const f = base().on('PUT', CONFIG, savedAnswer({ mountsUnknown: true }));
    const v = await openConfig(f);
    await v.press(TAB, CTRL('d'));
    expect(flat(v.frame())).not.toContain('/app/config.json');
    await v.press(...TO_SAVE, ENTER);
    await v.until("Config files of mybot saved. The manager has no record of the mounts the last build made, so it can't tell whether Start is enough");
    expect(putFiles(f)).toEqual([[{ path: '/app/gateway.conf', body: 'x\n', enabled: true }]]);
    v.unmount();
  });

  it('Add config file: an empty body is not sent; the body written in the editor is', async () => {
    const f = base([]).on('PUT', CONFIG, savedAnswer());
    const v = await openConfig(f);
    expect(keyBar(v.frame())).toContain('Enter Add config file');
    await v.press(ENTER);
    await v.type('/app/new.txt');
    await v.press(TAB, TAB);
    expect(keyBar(v.frame())).toContain('Enter Edit in nano');
    await v.press(ENTER);
    await v.until('Took the edited body of /app/new.txt; it is sent when you save.');
    expect(v.edits).toHaveLength(1);
    expect(v.edits[0].state).toMatchObject({ screen: 'config', botId: 'b1' });
    expect(v.edits[0].request.name).toBe('/app/new.txt');
    expect(flat(v.frame())).toContain('Body 1 line; Enter edits it in nano');
    await v.press(...TO_SAVE, ENTER);
    await v.until('Config files of mybot saved.');
    expect(putFiles(f)).toEqual([[{ path: '/app/new.txt', body: 'edited: true\n', enabled: true }]]);
    v.unmount();

    const g = base([]).on('PUT', CONFIG, savedAnswer());
    const w = await openConfig(g);
    await w.press(ENTER);
    await w.type('/app/empty.txt');
    await w.press(...TO_SAVE, ENTER);
    await w.until('Config files of mybot saved.');
    expect(putFiles(g)).toEqual([[]]);
    w.unmount();
  });

  it('an editor that fails, or leaves the file alone, keeps the body and says so', async () => {
    const f = base([SAVED]).on('PUT', CONFIG, savedAnswer());
    const v = await openConfig(f, { editMode: 'fail' });
    await v.press(TAB, TAB, TAB, ENTER);
    await v.until('exited with code 1; the body was not changed.');
    v.unmount();
    const g = base([SAVED]).on('PUT', CONFIG, savedAnswer());
    const w = await openConfig(g, { editMode: 'leave' });
    await w.press(TAB, TAB, TAB, ENTER);
    await w.until('No change to /app/config.json.');
    await w.press(...TO_SAVE, ENTER);
    await w.until('Config files of mybot saved.');
    expect(putFiles(g)[0]).toEqual([{ path: '/app/config.json', body: '{\n  "prefix": "!"\n}\n', readOnly: true, enabled: true }]);
    w.unmount();
  });

  it('the edited form outlives a remount at the same screen, as after the real hand-off', async () => {
    const f = base([SAVED]).on('PUT', CONFIG, savedAnswer());
    const v = await openConfig(f);
    await v.press(TAB, TAB, TAB, ENTER);
    await v.until('Took the edited body of /app/config.json');
    const { session } = v;
    const state = v.edits[0].state;
    v.unmount();
    const w = await start(f, { session, initial: state });
    await w.until('Config Files: mybot');
    await w.until('Took the edited body of /app/config.json');
    await w.press(...TO_SAVE, ENTER);
    await w.until('Config files of mybot saved.');
    expect(putFiles(f)[0]).toEqual([{ path: '/app/config.json', body: 'edited: true\n', readOnly: true, enabled: true }]);
    w.unmount();
  });

  it('a refusal shows the route text and keeps the editor; no answer says can not confirm', async () => {
    const f = base([SAVED]).on('PUT', CONFIG, migrating());
    const v = await openConfig(f);
    await v.press(...TO_SAVE, ENTER);
    await v.until('mybot: A data migration to Postgres is open on this bot, so its files cannot change until it ends; nothing was changed');
    expect(keyBar(v.frame())).toContain('Enter Save');
    expect(v.frames.map(flat).join(' ')).not.toContain('Config files of mybot saved');
    v.unmount();
    const g = base([SAVED]).on('PUT', CONFIG, noAnswer());
    const w = await openConfig(g);
    await w.press(...TO_SAVE, ENTER);
    await w.until("can't confirm the config files of mybot were saved: the manager did not answer (connect ECONNREFUSED 127.0.0.1:8080).");
    expect(keyBar(w.frame())).toContain('Enter Save');
    w.unmount();
  });

  it('asks before replacing a stored copy that no longer decrypts; another key cancels', async () => {
    const lost = file({ path: '/app/secret.json', body: '', bodyUndecryptable: true });
    const f = base([lost]).on('PUT', CONFIG, savedAnswer());
    const v = await openConfig(f);
    expect(flat(v.frame())).toContain('The stored file no longer decrypts (the encryption key changed). Leave it empty to keep the stored copy');
    await v.press(TAB, TAB, TAB, ENTER);
    await v.until('Took the edited body of /app/secret.json');
    await v.press(...TO_SAVE, ENTER);
    await v.until('The stored copy of /app/secret.json no longer decrypts. Saving replaces it with what you entered');
    await v.press('n');
    await v.until('Cancelled: nothing was saved.');
    expect(putFiles(f)).toEqual([]);
    await v.press(ENTER);
    await v.until('no longer decrypts. Saving replaces it');
    await v.press('y');
    await v.until('Config files of mybot saved.');
    expect(putFiles(f)).toEqual([[{ path: '/app/secret.json', body: 'edited: true\n', enabled: true }]]);
    v.unmount();
  });
});

// A guided file as the config route sends it: a manifest cut to a select and a text field.
const MANIFEST = {
  target: 'general.json',
  format: 'json',
  sections: [{
    id: 'main',
    title: 'Main',
    fields: [
      { type: 'select', label: 'Language', default: 'english', options: [{ value: 'english' }, { value: 'dutch' }], target: { kind: 'json', path: 'language' } },
      { type: 'text', label: 'Prefix', default: '!', target: { kind: 'json', path: 'prefix' } },
    ],
  }],
};
const GBODY = '{\n  "language": "english",\n  "prefix": "!"\n}\n';
const guidedFile = () => file({ path: '/app/general.json', body: GBODY, manifest: MANIFEST, parsed: (parseConfig('json', GBODY) as { data: unknown }).data });

describe('m3 config editor: a guided file', () => {
  it('shows the form, writes a change through serialize, and saves that body', async () => {
    const f = base([guidedFile()]).on('PUT', CONFIG, savedAnswer());
    const v = await openConfig(f);
    await v.until('Language');
    expect(flat(v.frame())).toContain('Raw body 4 lines; Enter edits it in nano');
    await v.press(TAB, TAB, TAB, TAB, RIGHT);
    for (let i = 0; i < 50 && !f.paths().includes('POST /api/config/serialize'); i++) await tick(20);
    await v.press(...TO_SAVE, ENTER);
    await v.until('Config files of mybot saved.');
    const sent = putFiles(f)[0] as Array<{ body: string }>;
    expect(sent[0].body).toContain('"language": "dutch"');
    v.unmount();
  });

  it('a raw edit in the editor is parsed again into the form', async () => {
    const f = base([guidedFile()]).on('PUT', CONFIG, savedAnswer());
    const v = await openConfig(f, { editMode: 'rewrite' });
    await v.press(TAB, TAB, TAB, ENTER);
    await v.until('Took the edited body of /app/general.json');
    for (let i = 0; i < 50 && !f.paths().includes('POST /api/config/parse'); i++) await tick(20);
    expect(f.calls.find((c) => c.path === '/api/config/parse')?.body).toEqual({ format: 'json', body: 'edited: true\n' });
    v.unmount();
  });
});

describe('m3 install form: config pieces', () => {
  function installBase(): Fake {
    return fake()
      .on('GET', '/api/bots', botList([]))
      .on('GET', '/api/sources', sourceList([gitSource()]))
      .on('GET', '/api/sources/s1/envs', repoEnvs({
        vars: [],
        configFiles: [{ inContainerPath: '/app/config.json', targetName: 'config.json', format: 'json', rawBody: '{}\n', keys: [], manifest: null, parsed: null, repoReadOnly: true }],
      }))
      .on('GET', NAME_PATH('coolbot'), nameOk('coolbot'))
      .on('POST', '/api/bots', created())
      .on('PUT', '/api/bots/b9/env', envSaved())
      .on('PUT', '/api/bots/b9/config', configSaved());
  }

  it('edits the path, the body in the editor, Writable, and adds a file; Install sends them as the page does', async () => {
    const f = installBase();
    const v = await start(f);
    await v.press('i');
    await v.until('coolbot');
    await v.press(ENTER);
    await v.until('Compose name: coolbot');
    // From the name: the generic token row's key and value, then the file line and its path.
    await v.press(TAB, TAB, TAB, TAB);
    await v.type('5');
    await v.press(TAB);
    expect(flat(v.frame())).toContain("Untouched, the file keeps the mode the repo's compose gives it (read-only).");
    await v.press(TAB, ENTER);
    await v.until('Took the edited body of /app/config.json5; it is sent when you install.');
    await v.press(TAB, ENTER);
    await v.type('/app/extra.txt');
    await v.press(TAB, ' ', TAB, ENTER);
    await v.until('Took the edited body of /app/extra.txt');
    await v.press(...tabs(10), ENTER);
    await v.until('Bot instance coolbot (b9) created');
    const put = f.calls.find((c) => c.path === '/api/bots/b9/config')?.body;
    expect(put).toEqual({ files: [
      { path: '/app/config.json5', body: 'edited: true\n', enabled: true },
      { path: '/app/extra.txt', body: 'edited: true\n', readOnly: false, enabled: true },
    ] });
    v.unmount();
  });
});

describe('m3 key bar', () => {
  it('wraps between keys onto a second line on the stopped bot screen at 80 columns, every key whole', async () => {
    const f = base();
    const v = await start(f, { columns: 80, rows: 24 });
    await v.press(ENTER);
    await v.until('Name mybot');
    const lines = v.frame().split('\n');
    const bar = [lines.at(-3) ?? '', lines.at(-2) ?? ''].map((l) => l.replace(/^\| /, '').replace(/\s*\|$/, ''));
    expect(bar[0]).toMatch(/^S Start {2}R Restart/);
    const keys = bar.join('  ');
    for (const k of ['S Start', 'R Restart', 'B Build', 'U Update', 'L Logs', 'G Build logs', 'E Env', 'C Config', 'Esc Back', 'Q Quit']) expect(keys).toContain(k);
    for (const l of lines) expect(l.length).toBeLessThanOrEqual(79);
    expect(lines).toHaveLength(23);
    v.unmount();
  });

  it('keyLines breaks only between keys and keeps a short bar on one line', () => {
    expect(keyLines('A One  B Two  C Three', 13)).toEqual(['A One  B Two', 'C Three']);
    expect(keyLines('Q Quit', 75)).toEqual(['Q Quit']);
  });

  // The stopped bot's bar, X Delete included, is 113 characters.
  it('keeps the bar on one line at 120 columns', async () => {
    const f = base();
    const v = await start(f, { rows: 24, columns: 120 });
    await v.press(ENTER);
    await v.until('Name mybot');
    expect(keyBar(v.frame())).toMatch(/S Start {2}R Restart.*Q Quit/);
    v.unmount();
  });
});


describe('m3 fix 1: a guided body waits for its form before nano opens', () => {
  // The serialize answers after 600 ms, so Enter on the body waits on the flush of the select change.
  const slow = (f: Fake) => f.on('POST', '/api/config/serialize', async (b) => {
    await tick(600);
    const { format, body, ops } = b as { format: 'json'; body: string; ops: ConfigOp[] };
    return ok({ success: true, ...serializeConfig(format, body, ops) });
  });

  it('in the config editor, keys wait (Esc too) and nano opens on the editor that asked', async () => {
    const f = slow(base([guidedFile()]).on('PUT', CONFIG, savedAnswer()));
    const v = await openConfig(f);
    await v.press(TAB, TAB, TAB, TAB, RIGHT, '\u001B[A', ENTER, ESC);
    expect(keyBar(v.frame())).toContain('Waiting for the manager');
    expect(flat(v.frame())).toContain('Config Files: mybot');
    await v.until('Took the edited body of /app/general.json');
    expect(v.edits).toHaveLength(1);
    expect(v.edits[0].request.body).toContain('"language": "dutch"');
    v.unmount();
  });

  it('in the install form, keys wait (Esc too) and nano opens on the form that asked', async () => {
    const f = slow(fake()
      .on('GET', '/api/bots', botList([]))
      .on('GET', '/api/sources', sourceList([gitSource()]))
      .on('GET', '/api/sources/s1/envs', repoEnvs({
        vars: [],
        configFiles: [{ inContainerPath: '/app/general.json', targetName: 'general.json', format: 'json', rawBody: GBODY, keys: [], manifest: MANIFEST, parsed: (parseConfig('json', GBODY) as { data: unknown }).data }],
      }))
      .on('GET', NAME_PATH('coolbot'), nameOk('coolbot')));
    const v = await start(f);
    await v.press('i');
    await v.until('coolbot');
    await v.press(ENTER);
    await v.until('Compose name: coolbot');
    // From the name: the token row's key and value, the file line, path, Writable, body, then the form.
    await v.press(...tabs(7), RIGHT, '\u001B[A', ENTER, ESC);
    expect(keyBar(v.frame())).toContain('Waiting for the manager');
    expect(flat(v.frame())).toContain('Install from Source: coolbot');
    await v.until('Took the edited body of /app/general.json; it is sent when you install.');
    expect(v.edits).toHaveLength(1);
    v.unmount();
  });
});

describe('m3 fix 1b: a serialize that never answers', () => {
  const never = (f: Fake) => f.on('POST', '/api/config/serialize', () => new Promise(() => {}));

  it('the config editor stops waiting after its limit, says so, opens nothing, and Esc works', async () => {
    const f = never(base([guidedFile()]));
    const session = new Session(f.client, () => 0);
    await session.refresh();
    const edits: EditRequest[] = [];
    const view = render(createElement(App, {
      machine: 'box1', session, onHandOff: vi.fn(), onEdit: (_s: FrameState, r: EditRequest) => edits.push(r), now: () => 0, configOptions: { flushMs: 300 },
    }));
    (view.stdout as unknown as { rows: number }).rows = 60;
    view.stdout.emit('resize');
    await tick();
    const frame = () => flat(view.lastFrame() ?? '');
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
    await press(ENTER, 'c');
    await until('Config Files: mybot');
    await press(TAB, TAB, TAB, TAB, RIGHT, '\u001B[A', ENTER);
    await until('A form change could not be written into the file (see the warning on the file), so its raw body was not opened.');
    expect(edits).toEqual([]);
    await press(ESC);
    await until('Name mybot');
    view.unmount();
  });

  it('the install form stops waiting after its limit too', async () => {
    const f = never(fake()
      .on('GET', '/api/bots', botList([]))
      .on('GET', '/api/sources', sourceList([gitSource()]))
      .on('GET', '/api/sources/s1/envs', repoEnvs({
        vars: [],
        configFiles: [{ inContainerPath: '/app/general.json', targetName: 'general.json', format: 'json', rawBody: GBODY, keys: [], manifest: MANIFEST, parsed: (parseConfig('json', GBODY) as { data: unknown }).data }],
      }))
      .on('GET', NAME_PATH('coolbot'), nameOk('coolbot')));
    const session = new Session(f.client, () => 0);
    await session.refresh();
    const edits: EditRequest[] = [];
    const view = render(createElement(App, {
      machine: 'box1', session, onHandOff: vi.fn(), onEdit: (_s: FrameState, r: EditRequest) => edits.push(r), now: () => 0, wizardOptions: { flushMs: 300 },
    }));
    (view.stdout as unknown as { rows: number }).rows = 60;
    view.stdout.emit('resize');
    await tick();
    const frame = () => flat(view.lastFrame() ?? '');
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
    await press('i');
    await until('coolbot');
    await press(ENTER);
    await until('Compose name: coolbot');
    await press(...tabs(7), RIGHT, '\u001B[A', ENTER);
    await until('A form change could not be written into the file (see the warning on the file), so its raw body was not opened.');
    expect(edits).toEqual([]);
    await press(ESC);
    await until('Sources');
    view.unmount();
  });
});
