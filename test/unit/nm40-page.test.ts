import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';
import { describe, expect, it } from 'vitest';
import { decommissionOutcome } from '../../src/cli/tui/dbtext';

const pageHtml = fs.readFileSync(path.resolve(__dirname, '../../src/webui/public/index.html'), 'utf8');
const pageFunction = (name: string): string => {
  let start = pageHtml.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`no function ${name}`);
  if (pageHtml.slice(start - 6, start) === 'async ') start -= 6;
  let i = pageHtml.indexOf('(', start);
  for (let depth = 0; ; i++) {
    if (pageHtml[i] === '(') depth++;
    else if (pageHtml[i] === ')' && --depth === 0) break;
  }
  i = pageHtml.indexOf('{', i);
  for (let depth = 0; ; i++) {
    if (pageHtml[i] === '{') depth++;
    else if (pageHtml[i] === '}' && --depth === 0) return pageHtml.slice(start, i + 1);
  }
};

const NOTE = "DATA_BACKEND was removed from this instance's env vars, so the manager now reads it as a files bot. What the bot runs on at its next start depends on its own settings in its data folder, which the manager can't confirm.";
// decommissionFleetDb's warning when the env store refused the URL's delete (nm40-decom.test.ts T12): it ends with no period.
const WARNING = "The database env pins DATA_BACKEND_URL could not be removed (EACCES: permission denied, open 'storage.json.tmp'); delete them in the Env editor";

async function pageShows(answer: Record<string, unknown>): Promise<string[]> {
  const shown: string[][] = [];
  const ctx = vm.createContext({
    confirm: () => true,
    api: async () => answer,
    showMessage: (kind: string, text: string) => { shown.push([kind, text]); },
    showNoAnswer: () => { shown.push(['noanswer', '']); },
    loadBots: async () => {},
    fleetBackupBotId: null,
    showFleetBackups: () => {},
  });
  vm.runInContext(pageFunction('decommissionFleetDb'), ctx);
  await ctx.decommissionFleetDb('b1');
  expect(shown).toHaveLength(1);
  return shown[0];
}

describe('NM40 T14: the page appends the env note to the decommission answer', () => {
  it('success with a note', async () => {
    expect(await pageShows({ success: true, dumpFile: 'd.dump', envNote: NOTE }))
      .toEqual(['success', `Database decommissioned; safety dump kept: d.dump. ${NOTE}`]);
  });
  it('warning with a note', async () => {
    expect(await pageShows({ success: true, dumpFile: 'd.dump', warning: WARNING, envNote: NOTE }))
      .toEqual(['error', `Database decommissioned; safety dump kept: d.dump. ${WARNING}. ${NOTE}`]);
  });
  it('no note: the old texts', async () => {
    expect(await pageShows({ success: true, dumpFile: 'd.dump' })).toEqual(['success', 'Database decommissioned; safety dump kept: d.dump.']);
    expect(await pageShows({ success: true, dumpFile: 'd.dump', warning: WARNING })).toEqual(['error', `Database decommissioned; safety dump kept: d.dump. ${WARNING}`]);
  });
});

describe('NM40 T15: the terminal appends the env note to the decommission answer', () => {
  it('success, warning and no answer', () => {
    expect(decommissionOutcome({ ok: true, value: { success: true, dumpFile: 'd.dump', envNote: NOTE } }))
      .toEqual({ ok: true, text: `Database decommissioned; safety dump kept: d.dump. ${NOTE}` });
    expect(decommissionOutcome({ ok: true, value: { success: true, envNote: NOTE } }))
      .toEqual({ ok: true, text: `Database decommissioned; no dump was taken (its volume no longer existed - an earlier attempt's dump, if any, is in the backups list). ${NOTE}` });
    expect(decommissionOutcome({ ok: true, value: { success: true, dumpFile: 'd.dump', warning: WARNING, envNote: NOTE } }))
      .toEqual({ ok: false, text: `Database decommissioned; safety dump kept: d.dump. ${WARNING}. ${NOTE}` });
    expect(decommissionOutcome({ ok: true, value: { success: true, dumpFile: 'd.dump' } }))
      .toEqual({ ok: true, text: 'Database decommissioned; safety dump kept: d.dump.' });
    expect(decommissionOutcome({ ok: null } as any).ok).toBeNull();
  });
});
