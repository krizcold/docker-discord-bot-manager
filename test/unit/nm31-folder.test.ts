import { afterAll, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { folderStep, newFolderState, FolderAnswer, FolderData, NewFolderState } from '../../src/instance/keptData';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nm31-folder-'));
afterAll(() => { fs.rmSync(root, { recursive: true, force: true }); });

const refuses = (a: FolderAnswer) => typeof a === 'object' && typeof a.refuse === 'string' && a.refuse.length > 0;

describe('nm31 folder: the forward table (3.6)', () => {
  const rows: Array<[string, FolderData, 'absent' | 'present', NewFolderState, FolderAnswer | 'refuse' | 'gone' | 'not-ours-in' | 'not-ours-data']> = [
    ['forward (1 of 15): present, absent, absent: build-in', 'full', 'absent', 'absent', 'build-in'],
    ['forward (2 of 15): present, absent, partial: build-in', 'full', 'absent', 'partial', 'build-in'],
    ['forward (3 of 15): present, absent, built: move-out', 'full', 'absent', 'built', 'move-out'],
    ['forward (4 of 15): present, absent, foreign: refuse T-N-NOTOURS on the new folder', 'full', 'absent', 'foreign', 'not-ours-in'],
    ['forward (5 of 15): absent, present, built: move-in', 'absent', 'present', 'built', 'move-in'],
    ['forward (6 of 15): absent, present, absent: refuse, no complete new folder', 'absent', 'present', 'absent', 'refuse'],
    ['forward (7 of 15): absent, present, partial: refuse, no complete new folder', 'absent', 'present', 'partial', 'refuse'],
    ['forward (8 of 15): absent, present, foreign: refuse, no complete new folder', 'absent', 'present', 'foreign', 'refuse'],
    ['forward (9 of 15): empty, present, built: clear-empty', 'empty', 'present', 'built', 'clear-empty'],
    ['forward (10 of 15): full, present, built: refuse T-N-NOTOURS on the data folder', 'full', 'present', 'built', 'not-ours-data'],
    ['forward (11 of 15): present, present, absent: done', 'full', 'present', 'absent', 'done'],
    ['forward (12 of 15): absent, absent, built: refuse, the data folder is gone (A3 code review 1)', 'absent', 'absent', 'built', 'gone'],
    ['forward (13 of 15): absent, absent, absent: refuse, no folder to bring in', 'absent', 'absent', 'absent', 'refuse'],
    ['forward (14 of 15): absent, absent, partial: refuse, no folder to bring in', 'absent', 'absent', 'partial', 'refuse'],
    ['forward (15 of 15): absent, absent, foreign: refuse, no folder to bring in', 'absent', 'absent', 'foreign', 'refuse'],
  ];
  it.each(rows)('%s', (_n, data, out, inState, want) => {
    const a = folderStep('forward', data, out, inState);
    if (want === 'gone') {
      expect(a).toEqual({ refuse: 'the data folder is gone, so nothing was set aside', gone: true });
    } else if (want === 'refuse') {
      expect(refuses(a)).toBe(true);
      expect((a as { notOurs?: string }).notOurs).toBeUndefined();
      expect((a as { refuse: string }).refuse).toBe(out === 'present' ? 'no complete new folder to bring in' : 'no folder to bring in');
    } else if (want === 'not-ours-in' || want === 'not-ours-data') {
      expect(refuses(a)).toBe(true);
      expect((a as { notOurs?: string }).notOurs).toBe(want === 'not-ours-in' ? 'in' : 'data');
    } else {
      expect(a).toBe(want);
    }
  });
});

describe('nm31 folder: the back and undo table (3.6)', () => {
  type Want = FolderAnswer | 'refuse';
  const table: Array<[string, FolderData, 'absent' | 'present', 'absent' | 'present', Want, Want]> = [
    ['present, absent, absent', 'full', 'absent', 'absent', 'refuse', 'done'],
    ['present, absent, present', 'full', 'absent', 'present', 'move-out', 'move-out'],
    ['absent, present, present', 'absent', 'present', 'present', 'move-in', 'move-in'],
    ['empty, present, present', 'empty', 'present', 'present', 'clear-empty', 'clear-empty'],
    ['full, present, present', 'full', 'present', 'present', 'refuse', 'refuse'],
    ['present, present, absent', 'full', 'present', 'absent', 'done', 'done'],
    ['absent, absent, present', 'absent', 'absent', 'present', 'move-in', 'move-in'],
    ['absent, present or absent, absent (undo per C10, code review 2)', 'absent', 'present', 'absent', 'refuse', 'missing'],
  ];
  const rows = table.flatMap(([cell, data, out, inState, back, undo], i) => [
    [`back (${i * 2 + 1} of 16): ${cell}: ${back}`, 'back', data, out, inState, back],
    [`undo (${i * 2 + 2} of 16): ${cell}: ${undo}`, 'undo', data, out, inState, undo],
  ] as Array<[string, 'back' | 'undo', FolderData, 'absent' | 'present', 'absent' | 'present', Want]>);
  it.each(rows)('%s', (_n, mode, data, out, inState, want) => {
    const outsOf = _n.includes('present or absent') ? ['present', 'absent'] as const : [out];
    for (const o of outsOf) {
      const a = folderStep(mode, data, o, inState);
      if (want === 'refuse') expect(refuses(a)).toBe(true);
      else expect(a).toBe(want);
    }
  });
});

describe('nm31 folder: newFolderState', () => {
  const dir = (name: string) => path.join(root, name);
  const saved = (state: string) => JSON.stringify({ state, message: 'Back soon', since: '2026-11-17T10:00:00.000Z' }, null, 2);

  it('newFolderState (1 of 4): absent when nothing is at the name', () => {
    expect(newFolderState(dir('none'))).toBe('absent');
  });

  it('newFolderState (2 of 4): partial with only N4\'s names and no valid maintenance.json', () => {
    const d = dir('partial');
    fs.mkdirSync(path.join(d, 'db-certs'), { recursive: true });
    fs.writeFileSync(path.join(d, 'db-certs', 'main.crt'), 'cert');
    fs.writeFileSync(path.join(d, 'maintenance.json.tmp'), saved('maintenance'));
    expect(newFolderState(d)).toBe('partial');
    fs.writeFileSync(path.join(d, 'maintenance.json'), '{"state":"maint');
    expect(newFolderState(d)).toBe('partial');
    fs.writeFileSync(path.join(d, 'maintenance.json'), saved('running'));
    expect(newFolderState(d)).toBe('partial');
  });

  it('newFolderState (3 of 4): built when maintenance.json says maintenance and db-certs holds only *.crt files', () => {
    const d = dir('built');
    fs.mkdirSync(path.join(d, 'db-certs'), { recursive: true });
    fs.writeFileSync(path.join(d, 'db-certs', 'main.crt'), 'cert');
    fs.writeFileSync(path.join(d, 'maintenance.json'), saved('maintenance'));
    expect(newFolderState(d)).toBe('built');
    const bare = dir('built-bare');
    fs.mkdirSync(bare);
    fs.writeFileSync(path.join(bare, 'maintenance.json'), saved('maintenance'));
    expect(newFolderState(bare)).toBe('built');
  });

  it('newFolderState (4 of 4): foreign with any other entry, a non-crt certificate file or a file at the name', () => {
    const d = dir('foreign');
    fs.mkdirSync(d);
    fs.writeFileSync(path.join(d, 'maintenance.json'), saved('maintenance'));
    fs.writeFileSync(path.join(d, '.env'), 'TOKEN=x');
    expect(newFolderState(d)).toBe('foreign');
    const c = dir('foreign-cert');
    fs.mkdirSync(path.join(c, 'db-certs'), { recursive: true });
    fs.writeFileSync(path.join(c, 'db-certs', 'notes.txt'), 'x');
    expect(newFolderState(c)).toBe('foreign');
    const f = dir('a-file');
    fs.writeFileSync(f, 'x');
    expect(newFolderState(f)).toBe('foreign');
  });
});

describe('nm31 folder: properties', () => {
  const datas: FolderData[] = ['absent', 'empty', 'full'];
  const outs: Array<'absent' | 'present'> = ['absent', 'present'];
  const forwardIns: NewFolderState[] = ['absent', 'partial', 'built', 'foreign'];
  const plainIns: Array<'absent' | 'present'> = ['absent', 'present'];
  const every = [
    ...datas.flatMap(d => outs.flatMap(o => forwardIns.map(i => ['forward', d, o, i] as const))),
    ...(['back', 'undo'] as const).flatMap(m => datas.flatMap(d => outs.flatMap(o => plainIns.map(i => [m, d, o, i] as const)))),
  ];

  it('property (1 of 3): no move answer renames onto an existing path', () => {
    for (const [mode, data, out, inState] of every) {
      const a = folderStep(mode, data, out, inState);
      if (a === 'move-out') {
        expect(out, `${mode} ${data} ${out} ${inState}`).toBe('absent');
        expect(data).not.toBe('absent');
      }
      if (a === 'move-in') {
        expect(data, `${mode} ${data} ${out} ${inState}`).toBe('absent');
        expect(inState).not.toBe('absent');
      }
    }
  });

  it('property (2 of 3): clear-empty only for an empty data folder', () => {
    for (const [mode, data, out, inState] of every) {
      if (folderStep(mode, data, out, inState) === 'clear-empty') expect(data, `${mode} ${data} ${out} ${inState}`).toBe('empty');
    }
  });

  // A seeded generator in place of fast-check, which this repo's test folder does not install.
  const seed = Number(process.env.SMDB_TEST_SEED) || 20261117;
  function rng(s: number) {
    return () => {
      s = (s + 0x6d2b79f5) | 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  it(`property (3 of 3): every state the forward walk reaches ends in done within four applied steps (seed ${seed})`, () => {
    type S = { data: FolderData; out: 'absent' | 'present'; in: NewFolderState };
    const apply = (s: S, a: FolderAnswer): S => {
      if (a === 'build-in') return { ...s, in: 'built' };
      if (a === 'move-out') return { data: 'absent', out: 'present', in: s.in };
      if (a === 'move-in') return { data: 'full', out: s.out, in: 'absent' };
      if (a === 'clear-empty') return { ...s, data: 'absent' };
      throw new Error(`not a step: ${JSON.stringify(a)}`);
    };
    // The forward walk from a data folder, with a crash inside N4 (partial) and a docker-made empty dataDir between the
    // renames at any point it can occur.
    const r = rng(seed);
    const pick = <T,>(xs: T[]) => xs[Math.floor(r() * xs.length)];
    const reached = new Map<string, S>();
    for (let i = 0; i < 2000; i++) {
      let s: S = { data: pick<FolderData>(['empty', 'full']), out: 'absent', in: 'absent' };
      for (let k = 0; k < 6; k++) {
        reached.set(JSON.stringify(s), s);
        const a = folderStep('forward', s.data, s.out, s.in);
        if (a === 'done' || typeof a === 'object') break;
        if (a === 'build-in' && r() < 0.3) s = { ...s, in: 'partial' };
        else s = apply(s, a);
        if (s.data === 'absent' && r() < 0.3) s = { ...s, data: 'empty' };
      }
    }
    expect(reached.size).toBeGreaterThan(4);
    for (const start of reached.values()) {
      let s = start;
      let applied = 0;
      for (;;) {
        const a = folderStep('forward', s.data, s.out, s.in);
        if (a === 'done') break;
        expect(typeof a, `refused from ${JSON.stringify(start)} at ${JSON.stringify(s)}`).toBe('string');
        s = apply(s, a);
        applied++;
        expect(applied, `from ${JSON.stringify(start)}`).toBeLessThanOrEqual(4);
      }
    }
  });
});
