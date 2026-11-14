import { describe, expect, it } from 'vitest';
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { editBody, editorCommand, EditResult } from '../../src/cli/tui/editbody';
import { editHandOff } from '../../src/cli/tui/run';

const SCRIPT = path.join(__dirname, 'm3-editor.cjs');
const BODY = '{\n  "prefix": "!"\n}\n';

function fakeEditor(mode: string) {
  const report = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'm3-report-')), 'report.json');
  return { command: { program: process.execPath, args: [SCRIPT, mode, report] }, report };
}

const readReport = (report: string) => JSON.parse(fs.readFileSync(report, 'utf8')) as { file: string; mode: number; body: string };
const editDirs = () => fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('dbm-edit-')).sort();

describe('m3 editor hand-off: editBody', () => {
  it('a rewrite comes back as the new body; the file had the base name and mode 0600; the folder is gone', async () => {
    const { command, report } = fakeEditor('rewrite');
    const r = await editBody('/app/config/general.jsonc', BODY, command);
    expect(r).toEqual({ ok: true, changed: true, body: 'edited: true\n' });
    const seen = readReport(report);
    expect(path.basename(seen.file)).toBe('general.jsonc');
    expect(seen.body).toBe(BODY);
    if (process.platform !== 'win32') expect(seen.mode).toBe(0o600);
    expect(fs.existsSync(path.dirname(seen.file))).toBe(false);
  });

  it('an editor that leaves the file alone changes nothing; the folder is gone', async () => {
    const { command, report } = fakeEditor('leave');
    const r = await editBody('/app/config.json', BODY, command);
    expect(r).toEqual({ ok: true, changed: false, body: BODY });
    expect(fs.existsSync(path.dirname(readReport(report).file))).toBe(false);
  });

  it('an editor that exits 1 keeps the old body and says so; the folder is gone', async () => {
    const { command, report } = fakeEditor('fail');
    const r = await editBody('/app/config.json', BODY, command);
    expect(r.ok).toBe(false);
    expect((r as { text: string }).text).toMatch(/^node(\.exe)? exited with code 1; the body was not changed\.$/);
    expect(fs.existsSync(path.dirname(readReport(report).file))).toBe(false);
  });

  it('a file the editor removed cannot be read back: the body is kept and the folder is gone', async () => {
    const { command, report } = fakeEditor('delete');
    const r = await editBody('/app/config.json', BODY, command);
    expect(r.ok).toBe(false);
    expect((r as { text: string }).text).toMatch(/^Could not read the edited file back \(.*\); the body was not changed\.$/);
    expect(fs.existsSync(path.dirname(readReport(report).file))).toBe(false);
  });

  it('an editor that is not installed says so, and leaves no folder behind', async () => {
    // A temp folder of its own, so the check sees only this row's folders.
    const own = fs.mkdtempSync(path.join(os.tmpdir(), 'm3-tmp-'));
    const saved = { TMPDIR: process.env.TMPDIR, TMP: process.env.TMP, TEMP: process.env.TEMP };
    Object.assign(process.env, { TMPDIR: own, TMP: own, TEMP: own });
    try {
      expect(os.tmpdir()).toBe(own);
      const missing = path.join(own, 'm3-no-such-dir', 'nano');
      const r = await editBody('/app/config.json', BODY, { program: missing, args: ['-R'] });
      expect(r).toEqual({ ok: false, text: 'nano is not installed here; the body was not changed.' });
      expect(editDirs()).toEqual([]);
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  it('an emptied file is a change to an empty body', async () => {
    const { command } = fakeEditor('empty');
    expect(await editBody('/app/config.json', BODY, command)).toEqual({ ok: true, changed: true, body: '' });
  });
});

describe('m3 editor hand-off: the command', () => {
  it('is nano -R unless the check names another as a JSON list', () => {
    expect(editorCommand({})).toEqual({ program: 'nano', args: ['-R'] });
    expect(editorCommand({ DBM_TUI_CHECK_EDITOR: JSON.stringify(['node', 'x.cjs']) })).toEqual({ program: 'node', args: ['x.cjs'] });
    expect(() => editorCommand({ DBM_TUI_CHECK_EDITOR: '"nano"' })).toThrow('DBM_TUI_CHECK_EDITOR must be a JSON list of strings');
  });

  it('editHandOff hands the outcome to the request, and a bad check value is an outcome too', async () => {
    const modes = { enter: '', leave: '' };
    const got: EditResult[] = [];
    const { report } = fakeEditor('rewrite');
    await editHandOff({ name: '/app/a.txt', body: 'old\n', done: (r) => got.push(r) }, modes, {
      DBM_TUI_CHECK_EDITOR: JSON.stringify([process.execPath, SCRIPT, 'rewrite', report]),
    });
    await editHandOff({ name: '/app/a.txt', body: 'old\n', done: (r) => got.push(r) }, modes, { DBM_TUI_CHECK_EDITOR: 'nano' });
    expect(got[0]).toEqual({ ok: true, changed: true, body: 'edited: true\n' });
    expect(got[1].ok).toBe(false);
    expect((got[1] as { text: string }).text).toMatch(/^Could not open the body in an editor \(.*\); the body was not changed\.$/);
  });
});

describe('m3 editor hand-off: a signal while the editor runs', () => {
  for (const [signal, code] of [['SIGTERM', 143], ['SIGHUP', 129]] as const) {
    it(`${signal} removes the folder with the plaintext body and ends the process with ${code}`, async () => {
      const own = fs.mkdtempSync(path.join(os.tmpdir(), 'm3-sig-'));
      const report = path.join(own, 'report.json');
      const env = { ...process.env, TMPDIR: own, TMP: own, TEMP: own };
      const run = spawnSync(process.execPath, [path.join(__dirname, 'm3-signal.mjs'), signal, report], { env, encoding: 'utf8', timeout: 15_000 });
      const seen = readReport(report);
      expect(path.dirname(path.dirname(seen.file))).toBe(own);
      expect(seen.body).toBe('PLAINTEXT-BODY');
      expect(run.stdout).not.toContain('the edit finished');
      expect(run.status).toBe(code);
      expect(fs.readdirSync(own).filter((n) => n.startsWith('dbm-edit-'))).toEqual([]);
    });
  }
});
