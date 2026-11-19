import { afterAll, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm36-ui-'));
  process.env.DATA_DIR = dir;
  return { dir };
});

import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';
import { KEPT_TEXT, newStartDone } from '../../src/instance/keptData';
import type { KeptOpRecord, KeptStep } from '../../src/types';

afterAll(() => { fs.rmSync(h.dir, { recursive: true, force: true }); });

const pageHtml = fs.readFileSync(path.resolve(__dirname, '../../src/webui/public/index.html'), 'utf8');
const pageFunction = (name: string): string => {
  const start = pageHtml.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`no function ${name}`);
  let i = pageHtml.indexOf('{', pageHtml.indexOf(')', start));
  for (let depth = 0; ; i++) {
    if (pageHtml[i] === '{') depth++;
    else if (pageHtml[i] === '}' && --depth === 0) return pageHtml.slice(start, i + 1);
  }
};
const ctx = vm.createContext({}) as { keptStepWords: (r: unknown) => string[]; keptOpenLineText: (r: unknown) => string };
vm.runInContext(`${pageFunction('keptStepWords')}\n${pageFunction('keptOpenLineText')}\nthis.keptStepWords = keptStepWords; this.keptOpenLineText = keptOpenLineText;`, ctx);

const SET_ID = '2026-11-17T12-00-00-000Z';
const DATA_DIR = '/data/bots/bota/data';
const rec = (over: Partial<KeptOpRecord>): KeptOpRecord => ({
  op: 'new-start', set: SET_ID, stamp: SET_ID, startedAt: '2026-11-17T12:00:00.000Z', parts: ['db', 'folder'], dataDir: DATA_DIR,
  outDir: `${DATA_DIR}.kept-${SET_ID}`, inDir: `${DATA_DIR}.new-${SET_ID}`, offMessage: '', sharers: [], step: 'recorded', ...over,
});
/** The record as the page gets it: through JSON, so an absent field stays absent. */
const asPage = (r: KeptOpRecord) => JSON.parse(JSON.stringify(r));

const STEPS: KeptStep[] = ['recorded', 'db-stopped', 'db-out', 'swapped', 'folder', 'db-in', 'db-up', 'login'];
const PARTS: Array<KeptOpRecord['parts']> = [['db', 'folder'], ['copy', 'folder'], ['folder']];
const SSL: Array<boolean | undefined> = [true, false, undefined];

describe('nm36 ui: the TLS step word', () => {
  it('U1: newStartDone equals the page\'s keptStepWords for every part set, step and keptSsl; TLS is on exactly for db, true, db-up or login', () => {
    let cases = 0;
    for (const parts of PARTS) {
      for (const step of STEPS) {
        for (const keptSsl of SSL) {
          const r = rec({ parts, step, ...(keptSsl === undefined ? {} : { keptSsl }) });
          const words = newStartDone(r);
          expect(ctx.keptStepWords(asPage(r)), `${parts} ${step} ${keptSsl}`).toEqual(words);
          const want = parts.includes('db') && keptSsl === true && (step === 'db-up' || step === 'login');
          expect(words.includes('TLS is on'), `${parts} ${step} ${keptSsl}`).toBe(want);
          if (want) expect(words[words.indexOf('the new database started') + 1]).toBe('TLS is on');
          cases++;
        }
      }
    }
    expect(cases).toBe(72);
  });

  it('U2: the page\'s open line equals nOpen for keptSsl true at db-up and at login', () => {
    for (const step of ['db-up', 'login'] as KeptStep[]) {
      const r = rec({ step, keptSsl: true, lastError: "the bot's login on the new database could not be opened (x)" });
      expect(ctx.keptOpenLineText(asPage(r))).toBe(KEPT_TEXT.nOpen(r.lastError!, newStartDone(r)));
      expect(ctx.keptOpenLineText(asPage(r))).toContain('the new database started, TLS is on');
    }
  });

  it('U3: nDoneMain word for word with and without TLS, with and without the replication and sharers tails', () => {
    const base = { old: 'bota-fleet-postgres-data', outDir: '/d/data.kept-x', newVolume: 'bota-fleet-postgres-data-x', certs: false };
    const head = 'Started on a new database. The volume bota-fleet-postgres-data and the data folder /d/data.kept-x are kept unchanged under Kept data. The new database runs alone on the volume bota-fleet-postgres-data-x, with data checksums on';
    const tlsClause = ', TLS on as the kept database had it (with a certificate of its own, which Enable replication replaces),';
    const rest = " and the bot's login open; the Database URL is unchanged. The bot is stopped and its State is Running. Its new data folder holds maintenance.json so its next start is a maintenance boot; the other files of the old folder, its .env among them, stay in the kept folder.";
    const repl = ' Copies on other machines still follow the kept database: enable replication here, then Copy join code and Add a live copy on each machine.';
    const sharers = ' Bot b also use this database and still have their old data folders; run Start on a new database on each before you start it.';
    for (const tls of [true, false]) {
      for (const replication of [false, true]) {
        for (const sh of [null, 'Bot b']) {
          const text = KEPT_TEXT.nDoneMain({ ...base, replication, sharers: sh, ...(tls ? { tls: true } : {}) });
          expect(text).toBe(head + (tls ? tlsClause : '') + rest + (replication ? repl : '') + (sh ? sharers : ''));
        }
      }
    }
    expect(KEPT_TEXT.nDoneMain({ ...base, replication: false, sharers: null, tls: false })).toBe(KEPT_TEXT.nDoneMain({ ...base, replication: false, sharers: null }));
  });
});
