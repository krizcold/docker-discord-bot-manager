import { afterAll, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm31-ui-'));
  process.env.DATA_DIR = dir;
  return { dir };
});

import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';
import { KEPT_TEXT, deleteDone, keptDate, newStartDone, putBackDone } from '../../src/instance/keptData';
import { backupStatusLines, timeIn } from '../../src/cli/tui/dbtext';
import type { BackupFamilyStatus } from '../../src/cli/tui/api';
import type { KeptOpRecord, KeptStep } from '../../src/types';
import { family } from './m4-fake';

afterAll(() => { fs.rmSync(h.dir, { recursive: true, force: true }); });

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

const KEPT_FNS = ['keptOpName', 'keptSetDate', 'keptSetLine', 'keptStartShown', 'keptStartVariant', 'keptStartConfirmText', 'keptPutBackConfirmText',
  'keptDeleteConfirmText', 'keptStepWords', 'keptOpenLineText', 'keptDataHtml', 'renderKeptData', 'keptAnswer', 'keptStart', 'keptPutBack', 'keptDelete', 'keptKeep'];

type El = { innerHTML: string; textContent: string; isConnected: boolean; classList: { remove: () => void; add: () => void } };
const el = (): El => ({ innerHTML: '', textContent: '', isConnected: true, classList: { remove: () => {}, add: () => {} } });

const load = (names: string[], extra: Record<string, unknown> = {}) => {
  const els: Record<string, El> = {};
  const calls: Array<[string, string, unknown]> = [];
  const shown: Array<[string, string]> = [];
  const confirms: string[] = [];
  const ctx = vm.createContext({
    api: async (method: string, url: string, body: unknown) => { calls.push([method, url, body]); return { success: true, text: 'done' }; },
    showMessage: (k: string, t: string) => { shown.push([k, t]); },
    showNoAnswer: (op: string) => { shown.push(['noanswer', op]); },
    confirm: (t: string) => { confirms.push(t); return true; },
    loadBots: async () => {},
    showFleetBackups: () => {},
    setTimeout: () => 0,
    fleetBackupBotId: 'a',
    bots: [],
    document: { getElementById: (id: string) => (els[id] ??= el()) },
    Array, String, Number, JSON, Date, Math, Object, encodeURIComponent,
    ...extra,
  });
  vm.runInContext(['escapeHtml', 'jsArg', ...names].map(pageFunction).join('\n'), ctx);
  return { ctx, els, calls, shown, confirms };
};

const SET_ID = '2026-11-17T12-00-00-000Z';
const SET_DATE = keptDate(SET_ID);
const DATA_DIR = '/data/bots/bota/data';
const OUT = `${DATA_DIR}.kept-${SET_ID}`;
const IN = `${DATA_DIR}.new-${SET_ID}`;
const offBot = (over: Record<string, unknown> = {}) => ({
  id: 'a', displayName: 'Bot a', appHooks: true, maintenance: { state: 'off', settled: true, message: '' }, keptSets: [], keptOp: null, keptLast: null, ...over,
});
const mainSet = { id: SET_ID, keptAt: '2026-11-17T12:00:00.000Z', by: 'new-start', folder: OUT, db: { containerName: 'bota-fleet-postgres', user: 'smdb', db: 'smdb', volume: 'bota-fleet-postgres-data', password: '' } };
const rec = (over: Partial<KeptOpRecord>): KeptOpRecord => ({
  op: 'new-start', set: SET_ID, stamp: SET_ID, startedAt: '2026-11-17T12:00:00.000Z', parts: ['db', 'folder'], dataDir: DATA_DIR, outDir: OUT, inDir: IN,
  offMessage: '', sharers: [], step: 'recorded', ...over,
});

describe('nm31 ui: the Kept data group in the three layouts of the Database window', () => {
  const open = async (bot: Record<string, unknown>) => {
    const noop = () => {};
    const kept: string[] = [];
    const { ctx, els } = load(['showFleetBackups'], {
      bots: [bot], fleetBackupStored: null,
      fleetBackupListHtml: async () => '', fleetBackupErrorHtml: () => '', renderSeedBanner: noop, renderFleetReplication: noop, renderFleetSwitch: noop,
      refreshFleetBackupStatus: noop, renderFleetReplica: noop, renderPastFleetBackups: noop, refreshStateLine: noop, renderMemoryLine: noop,
      renderConnectionLine: noop, renderKeptData: (id: string) => { kept.push(id); },
    });
    await ctx.showFleetBackups('a');
    return { html: els['fleet-backup-content'].innerHTML, kept };
  };
  it('layout (1 of 3): a bot with no managed database holds the group and renders it', async () => {
    const { html, kept } = await open(offBot({ dataPlace: 'outside' }));
    expect(html).toContain('<div id="fleet-kept-data"></div>');
    expect(kept).toEqual(['a']);
  });
  it('layout (2 of 3): a live copy holds the group and renders it', async () => {
    const { html, kept } = await open(offBot({ fleetDbReplica: {} }));
    expect(html).toContain('<div id="fleet-kept-data"></div>');
    expect(kept).toEqual(['a']);
  });
  it('layout (3 of 3): the main holds the group and renders it', async () => {
    const { html, kept } = await open(offBot({ fleetDb: {} }));
    expect(html).toContain('<div id="fleet-kept-data"></div>');
    expect(kept).toEqual(['a']);
  });
});

describe('nm31 ui: the group\'s lines', () => {
  it('a set\'s line: its time, who set it aside, its parts, and Put back and Delete calling the set\'s routes', async () => {
    const copySet = { id: `${SET_ID}-new`, keptAt: '2026-11-17T13:05:00.000Z', by: 'put-back', folder: null, copy: { volume: 'bota-fleet-postgres-replica-data' } };
    const folderSet = { id: '2026-11-18T09-30-00-000Z', keptAt: '2026-11-18T09:30:00.000Z', by: 'new-start', folder: OUT };
    const { ctx, calls, confirms } = load(KEPT_FNS, { bots: [offBot({ fleetDb: {}, keptSets: [mainSet, copySet, folderSet] })] });
    expect(ctx.keptSetLine(mainSet)).toBe(`2026-11-17 12:00 UTC, set aside by Start on a new database: database volume bota-fleet-postgres-data, data folder ${OUT}`);
    // C7 (code review 1): the line takes its date from the set id, as its confirms and keptDate do
    expect(ctx.keptSetLine(copySet)).toBe('2026-11-17 12:00 UTC, set aside by Put back: live copy volume bota-fleet-postgres-replica-data');
    expect(ctx.keptSetLine(copySet).startsWith(keptDate(copySet.id))).toBe(true);
    expect(ctx.keptSetLine(folderSet)).toBe(`2026-11-18 09:30 UTC, set aside by Start on a new database: data folder ${OUT}`);
    const html = ctx.keptDataHtml(ctx.bots[0]);
    expect(html).toContain('Kept data');
    expect(html.match(/>Put back</g)?.length).toBe(3);
    expect(html.match(/>Delete</g)?.length).toBe(3);
    await ctx.keptPutBack('a', SET_ID, 'set');
    await ctx.keptDelete('a', SET_ID, false);
    expect(calls).toEqual([
      ['POST', `/bots/a/fleet-db/kept/${encodeURIComponent(SET_ID)}/put-back`, { reverse: false }],
      ['POST', `/bots/a/fleet-db/kept/${encodeURIComponent(SET_ID)}/delete`, { again: false }],
    ]);
    expect(confirms).toEqual([ctx.keptPutBackConfirmText(SET_DATE), ctx.keptDeleteConfirmText(SET_DATE)]);
    expect(ctx.keptStartShown(ctx.bots[0])).toBe(true);
    expect(html).toContain('>Start on a new database<');
    for (const hidden of [offBot({ fleetDb: {}, maintenance: { state: 'off', settled: false } }), offBot({ fleetDb: {}, maintenance: null }),
      offBot({ fleetDb: {}, keptOp: rec({}) }), offBot({ dataPlace: 'json' }), offBot({ fleetDb: {}, appHooks: false })]) {
      expect(ctx.keptStartShown(hidden)).toBe(false);
    }
  });

  it('open record (1 of 3): a new-start record reads T-N-OPEN with its steps; Run it again starts it again, Put back reverses it', async () => {
    const { ctx, calls, confirms } = load(KEPT_FNS, { bots: [offBot({ fleetDb: {}, keptOp: rec({ step: 'db-up', lastError: 'x' }) })] });
    const steps: KeptStep[] = ['recorded', 'db-stopped', 'db-out', 'swapped', 'folder', 'db-in', 'db-up', 'login'];
    for (const parts of [['db', 'folder'], ['copy', 'folder'], ['folder']] as Array<KeptOpRecord['parts']>) {
      for (const step of steps) {
        const r = rec({ parts, step, lastError: 'the database did not stop (timeout)' });
        expect(ctx.keptOpenLineText(r)).toBe(KEPT_TEXT.nOpen('the database did not stop (timeout)', newStartDone(r)));
      }
    }
    expect(ctx.keptOpenLineText(rec({ step: 'swapped' }))).toBe(KEPT_TEXT.nOpen('x', newStartDone(rec({ step: 'swapped' })))
      .replace('Start on a new database stopped before it finished: x.', 'Start on a new database has not finished: it runs now, or the manager restarted while it ran.'));
    const html = ctx.keptDataHtml(offBot({ fleetDb: {}, maintenance: { state: 'off', settled: true }, keptOp: rec({ step: 'db-up', lastError: 'x' }) }));
    expect(html).toContain('>Run it again<');
    expect(html).toContain('>Put back<');
    expect(html).not.toContain('>Keep it<');
    expect(html).not.toContain('>Start on a new database<');
    await ctx.keptStart('a');
    await ctx.keptPutBack('a', SET_ID, 'reverse');
    expect(calls).toEqual([
      ['POST', '/bots/a/fleet-db/new-start', {}],
      ['POST', `/bots/a/fleet-db/kept/${encodeURIComponent(SET_ID)}/put-back`, { reverse: true }],
    ]);
    expect(confirms).toEqual([ctx.keptPutBackConfirmText(SET_DATE)]);
    const undo = ctx.keptDataHtml(offBot({ keptOp: rec({ step: 'recorded', undo: true, lastError: 'x' }) }));
    // B4 and C2 (code review 1): a reverse offers no Put back to press
    expect(ctx.keptOpenLineText(rec({ step: 'swapped', undo: true, lastError: 'x' }))).toBe(`Put back stopped before it finished: x. Done so far: ${putBackDone(rec({ step: 'swapped' })).join(', ')}. Run it again to finish going back to the earlier data; until it finishes, the bot stays stopped and Start is refused.`);
    expect(undo).toContain('>Run it again<');
    expect(undo).not.toContain('>Put back<');
  });

  it('open record (2 of 3): a put-back record reads T-P-OPEN with its steps; Run it again goes on without reverse, Put back reverses it', async () => {
    const { ctx, calls, confirms } = load(KEPT_FNS);
    for (const step of ['recorded', 'db-stopped', 'db-out', 'swapped', 'folder', 'db-in', 'settled'] as KeptStep[]) {
      for (const parts of [['db', 'folder'], ['copy'], ['folder']] as Array<KeptOpRecord['parts']>) {
        const r = rec({ op: 'put-back', asideSet: '2026-11-17T13-00-00-000Z', parts, step, lastError: 'the data folder could not be renamed (EBUSY)' });
        expect(ctx.keptOpenLineText(r)).toBe(KEPT_TEXT.pOpen('the data folder could not be renamed (EBUSY)', putBackDone(r)));
      }
    }
    const html = ctx.keptDataHtml(offBot({ keptOp: rec({ op: 'put-back', step: 'swapped', lastError: 'x' }) }));
    expect(html).toContain('>Run it again<');
    expect(html).toContain('>Put back<');
    expect(html).not.toContain('>Keep it<');
    await ctx.keptPutBack('a', SET_ID, 'again');
    await ctx.keptPutBack('a', SET_ID, 'reverse');
    expect(calls.map(c => c[2])).toEqual([{ reverse: false }, { reverse: true }]);
    expect(confirms.length).toBe(1);
  });

  it('open record (3 of 3): a delete record reads a whole sentence alone, else T-X-OPEN; Keep it only before removing; Run it again sends again', async () => {
    const { ctx, calls, confirms } = load(KEPT_FNS);
    const whole = [KEPT_TEXT.xDisk(100, 2124), KEPT_TEXT.xDump('pg_dump exited 1') + KEPT_TEXT.xNoWork(mainSet.db.volume), KEPT_TEXT.xCheck('pre-delete-x.dump', 'counts differ'),
      KEPT_TEXT.xArchive('ENOSPC'), KEPT_TEXT.xArchCheck('x.tar', 'a.txt differs', '/k'), KEPT_TEXT.xPartial({ volume: 'v', err: 'in use', dump: 'd.dump' }),
      KEPT_TEXT.xCurrent('v'), KEPT_TEXT.xInUse('v', 'c1'), KEPT_TEXT.xPath('/x'), KEPT_TEXT.aDocker('v')];
    for (const text of whole) expect(ctx.keptOpenLineText(rec({ op: 'delete', parts: ['db', 'folder'], step: 'copy-made', lastError: text }))).toBe(text);
    for (const step of ['recorded', 'copy-made', 'dumped', 'scratch-gone', 'checked', 'archived', 'archive-checked', 'removing'] as KeptStep[]) {
      const r = rec({ op: 'delete', parts: ['db', 'folder'], step, lastError: 'the scratch copy smdb-keptcopy-a could not be removed (busy)' });
      expect(ctx.keptOpenLineText(r)).toBe(KEPT_TEXT.xOpen('the scratch copy smdb-keptcopy-a could not be removed (busy)', deleteDone(r), step !== 'removing'));
    }
    const before = ctx.keptDataHtml(offBot({ keptOp: rec({ op: 'delete', parts: ['folder'], step: 'archived', lastError: 'x' }) }));
    expect(before).toContain('>Run it again<');
    expect(before).toContain('>Keep it<');
    expect(before).not.toContain('>Put back<');
    const removing = ctx.keptDataHtml(offBot({ keptOp: rec({ op: 'delete', parts: ['folder'], step: 'removing', lastError: 'x' }) }));
    expect(removing).toContain('>Run it again<');
    expect(removing).not.toContain('>Keep it<');
    await ctx.keptDelete('a', SET_ID, true);
    await ctx.keptKeep('a');
    expect(calls).toEqual([
      ['POST', `/bots/a/fleet-db/kept/${encodeURIComponent(SET_ID)}/delete`, { again: true }],
      ['POST', '/bots/a/fleet-db/kept/abandon', {}],
    ]);
    expect(confirms).toEqual([]);
  });
});

describe('nm31 ui: the confirm texts', () => {
  const MAIN_TAIL = 'so its next start is a maintenance boot. The bot stays stopped, and its State becomes Running.\n\nPut back returns the kept database and folder; Delete removes them after a dump.';
  it('confirm (1 of 3): Start on a new database, per variant, with the certificate clause only for a joined bot', () => {
    const { ctx, confirms, calls } = load(KEPT_FNS, { bots: [offBot({ fleetDb: {}, keptStartVariant: 'main' })] }); // C13 (code review 3): the variant from the bot record
    expect(ctx.keptStartConfirmText(offBot({ fleetDb: {}, keptStartVariant: 'main' }))).toBe(`Start on a new database?\n\nThe bot's database is stopped, and its volume and the bot's data folder are kept as they are, the folder under the name data.kept-<the start's time>. A new empty database starts on a new volume with the same login, so the Database URL does not change. The bot gets a new data folder that holds maintenance.json ${MAIN_TAIL}`);
    expect(ctx.keptStartConfirmText(offBot({ fleetDb: {}, fleetJoin: {}, keptStartVariant: 'main' }))).toBe(`Start on a new database?\n\nThe bot's database is stopped, and its volume and the bot's data folder are kept as they are, the folder under the name data.kept-<the start's time>. A new empty database starts on a new volume with the same login, so the Database URL does not change. The bot gets a new data folder that holds maintenance.json, and the join's certificate files, ${MAIN_TAIL}`);
    expect(ctx.keptStartConfirmText(offBot({ dataPlace: 'outside', keptStartVariant: 'folder' }))).toBe(`Start on a new database?\n\nThe bot's data folder is kept as it is, under a new name, and its database is not changed. The bot gets a new data folder that holds maintenance.json ${MAIN_TAIL}`);
    expect(ctx.keptStartConfirmText(offBot({ fleetDbReplica: {}, fleetJoin: {}, keptStartVariant: 'copy' }))).toBe(`Start on a new database?\n\nThis machine's live copy is stopped, and its volume and the bot's data folder are kept as they are; this machine holds no live copy afterwards. The bot gets a new data folder that holds maintenance.json, and the join's certificate files, ${MAIN_TAIL}`);
    return ctx.keptStart('a').then(() => {
      expect(confirms).toEqual([ctx.keptStartConfirmText(offBot({ fleetDb: {}, keptStartVariant: 'main' }))]);
      expect(calls.length).toBe(1);
    });
  });
  it('confirm (2 of 3): Put back names the set\'s date', () => {
    const { ctx } = load(KEPT_FNS);
    expect(ctx.keptPutBackConfirmText(SET_DATE)).toBe('Put back the kept data of 2026-11-17 12:00 UTC?\n\nWhat is in use now is kept the same way, and the kept database and folder are used again. The bot stays Off.');
  });
  it('confirm (3 of 3): Delete names the set\'s date and the checks; a refused confirm sends nothing', async () => {
    const { ctx, calls } = load(KEPT_FNS, { confirm: () => false });
    expect(ctx.keptDeleteConfirmText(SET_DATE)).toBe('Delete the kept data of 2026-11-17 12:00 UTC?\n\nThe kept database is copied to a scratch volume, the copy is dumped and the dump is restored in a throwaway database to check it; the kept folder is archived and the archive checked. Only then are the volume and the folder removed. The dump and the archive stay in this manager\'s backups folder.');
    await ctx.keptDelete('a', SET_ID, false);
    await ctx.keptPutBack('a', SET_ID, 'set');
    await ctx.keptStart('a');
    expect(calls).toEqual([]);
  });
});

const KEPT_WAIT = "Backups wait until this bot's Start on a new database or Put back finishes.";

describe('nm31 ui: backups while a record is open (skip kept)', () => {
  it('the page: the family\'s line says backups wait, and the empty list does not promise a backup within a minute', async () => {
    const fns = ['backupTime', 'backupTestHtml', 'backupAlertHtml', 'backupStatusHtml', 'fleetBackupListHtml'];
    const { ctx } = load(fns, { api: async () => ({ success: true, backups: [] }) });
    const f = family({ skip: 'kept', lastFile: null, lastAt: null, test: null });
    const html = ctx.backupStatusHtml(f);
    expect(html).toBe(`<div class="env-tip">${KEPT_WAIT}</div>`);
    expect(html).not.toContain('No backup yet');
    const list = await ctx.fleetBackupListHtml('a', { enabled: true, scoped: true, main: f });
    expect(list).toBe(`<div class="env-tip">No backups. ${KEPT_WAIT}</div>`);
  });
  it('the terminal: backupStatusLines and the empty list say the same', async () => {
    const { emptyBackupsText } = await import('../../src/cli/tui/dbtext');
    const f = family({ skip: 'kept', lastFile: null, lastAt: null, test: null }) as BackupFamilyStatus;
    expect(backupStatusLines(f, timeIn('UTC')).map(l => l.text)).toEqual([KEPT_WAIT]);
    expect(emptyBackupsText({ enabled: true, scoped: true, main: f })).toBe(`No backups. ${KEPT_WAIT}`);
  });
});

describe('nm31 ui: code review 1, fix 2', () => {
  it('C3 (code review 1): a copy start that stopped the live copy says the live copy was stopped, in keptData and on the page', () => {
    const { ctx } = load(KEPT_FNS);
    const r = rec({ parts: ['copy', 'folder'], step: 'db-out', lastError: 'x' });
    expect(newStartDone(r)).toEqual(['the live copy was stopped', 'its service was taken out of the compose']);
    expect(ctx.keptStepWords(r)).toEqual(['the live copy was stopped', 'its service was taken out of the compose']);
    expect(newStartDone(rec({ parts: ['db', 'folder'], step: 'db-stopped' }))).toEqual(['the database was stopped']);
    expect(ctx.keptStepWords(rec({ parts: ['db', 'folder'], step: 'db-stopped' }))).toEqual(['the database was stopped']);
  });

  it('C5 (code review 1): the toast before the answer says the manager works on it, not that it runs', async () => {
    const { ctx, shown } = load(KEPT_FNS, { bots: [offBot({ fleetDb: {}, keptSets: [mainSet] })] });
    await ctx.keptPutBack('a', SET_ID, 'set');
    await ctx.keptKeep('a');
    const date = ctx.keptSetDate(SET_ID);
    expect(shown.filter(([k]) => k === 'info')).toEqual([ // C11 (code review 2): the action, not the button
      ['info', `The manager works on Put back of the kept data of ${date}; the result shows here when it finishes`],
      ['info', 'The manager works on stopping that Delete (Keep it); the result shows here when it finishes'],
    ]);
  });

  it('C11 (code review 2): the toasts of Start on a new database and Delete name the action', async () => {
    const { ctx, shown } = load(KEPT_FNS, { bots: [offBot({ fleetDb: {}, keptSets: [mainSet] })] });
    await ctx.keptStart('a');
    await ctx.keptDelete('a', SET_ID, false);
    const date = ctx.keptSetDate(SET_ID);
    expect(shown.filter(([k]) => k === 'info')).toEqual([
      ['info', 'The manager works on Start on a new database; the result shows here when it finishes'],
      ['info', `The manager works on Delete of the kept data of ${date}; the result shows here when it finishes`],
    ]);
  });
});

describe('nm31 ui: code review 3', () => {
  it('A10 page line (code review 3): an open new-start stopped on T-N-GONE ends with the server\'s gone tail, per variant', () => {
    const { ctx } = load(KEPT_FNS);
    for (const [parts, variant] of [[['db', 'folder'], 'main'], [['copy', 'folder'], 'copy'], [['folder'], 'folder']] as const) {
      const r = rec({ parts: [...parts], step: 'swapped', lastError: KEPT_TEXT.nGone(DATA_DIR), folderGone: true } as Partial<KeptOpRecord>);
      expect(ctx.keptOpenLineText(r)).toBe(KEPT_TEXT.nOpen(r.lastError!, newStartDone(r), variant));
    }
    const other = rec({ parts: ['db', 'folder'], step: 'swapped', lastError: 'x' });
    expect(ctx.keptOpenLineText(other)).toBe(KEPT_TEXT.nOpen('x', newStartDone(other)));
  });

  const TAIL = 'The bot gets a new data folder that holds maintenance.json so its next start is a maintenance boot. The bot stays stopped, and its State becomes Running.\n\nPut back returns the kept database and folder; Delete removes them after a dump.';

  it('C13 (code review 3): a main bot whose Database URL names another host gets the confirm of the folder variant, as the server runs it', async () => {
    const bot = offBot({ fleetDb: {}, keptStartVariant: 'folder' });
    const { ctx, confirms } = load(KEPT_FNS, { bots: [bot] });
    const folder = `Start on a new database?

The bot's data folder is kept as it is, under a new name, and its database is not changed. ${TAIL}`;
    expect(ctx.keptStartConfirmText(bot)).toBe(folder);
    await ctx.keptStart('a');
    expect(confirms).toEqual([folder]);
  });

  it('C13 (code review 3): a bot record without a variant gets a confirm saying the manager cannot confirm what is kept', () => {
    const { ctx } = load(KEPT_FNS);
    expect(ctx.keptStartConfirmText(offBot({ fleetDb: {}, keptStartVariant: null }))).toBe(`Start on a new database?

The manager can't confirm what this start keeps: when the bot list was last read, the bot's settings could not be read or named no database to start again. The start reads them again and refuses if that is still so. ${TAIL}`); // C17 (code review 4): the variant is from the last read of the bot list
  });

  it('C12 (code review 3): the window line of an open reverse whose folder step found the data folder missing says so', () => {
    const { ctx } = load(KEPT_FNS);
    const r = rec({ parts: ['folder'], step: 'folder', undo: true, folderMissing: true, lastError: 'x' } as Partial<KeptOpRecord>);
    expect(ctx.keptStepWords(r)).toEqual(['the kept data was recorded as in use and the data in use as kept', 'the data folder was found missing and left so']);
    expect(ctx.keptStepWords(r)).toEqual(putBackDone(r));
    expect(ctx.keptOpenLineText(r)).not.toContain('exchanged');
  });
});
