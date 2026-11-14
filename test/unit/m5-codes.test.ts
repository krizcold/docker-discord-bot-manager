import { describe, expect, it } from 'vitest';
import {
  CodeField, codeFieldNote, codeLines, codeScreenLines, COPY_ADVICE, JOIN_CODE_NOTES, joinCodeFailure, PasteReader, stripCode,
} from '../../src/cli/tui/codes';
import { JOIN_CODE } from './m5-fake';

const START = '\x1b[200~';
const END = '\x1b[201~';
const MOVE_CODE = 'smdbmove1.' + 'Ab9_-'.repeat(130);
const shown = (code = JOIN_CODE) => ({ title: 'Join code of mybot', code, notes: JOIN_CODE_NOTES });

describe('m5 the code screen lines', () => {
  it('cuts the code into lines of 64 characters that join back to the code', () => {
    const lines = codeLines(JOIN_CODE);
    expect(JOIN_CODE.length).toBeGreaterThan(380);
    expect(lines.slice(0, -1).every((l) => l.length === 64)).toBe(true);
    expect(lines.at(-1)!.length).toBeLessThanOrEqual(64);
    expect(lines.join('')).toBe(JOIN_CODE);
    expect(codeLines('')).toEqual([]);
  });

  for (const columns of [70, 80, 100]) {
    it(`shows the whole code at ${columns} columns, each code line alone from column 0, and every line inside the width`, () => {
      const lines = codeScreenLines(shown(), columns, 40);
      expect(lines[0].startsWith('+ Join code of mybot -')).toBe(true);
      const code = codeLines(JOIN_CODE);
      expect(lines.slice(1, 1 + code.length)).toEqual(code);
      expect(lines[1 + code.length]).toBe('');
      for (const l of lines) expect(l.length).toBeLessThanOrEqual(columns - 1);
      for (const l of lines.slice(1)) expect(l).not.toMatch(/^\| | \|$/);
      const text = lines.slice(2 + code.length).join(' ').replace(/\s+/g, ' ');
      expect(text).toContain('It holds database passwords: paste it only into your own managers.');
      expect(text).toContain(COPY_ADVICE);
      expect(text).toContain(`The code is ${JOIN_CODE.length} characters long, in ${code.length} lines.`);
      expect(lines.at(-1)).toBe('Esc Close');
      expect(lines.length).toBeLessThanOrEqual(39);
    });
  }

  it('shows a move code of 660 characters whole at 80 columns', () => {
    const lines = codeScreenLines(shown(MOVE_CODE), 80, 30);
    expect(lines.slice(1, 12).join('')).toBe(MOVE_CODE);
    expect(lines.join('\n')).toContain(`The code is ${MOVE_CODE.length} characters long, in 11 lines.`);
  });

  it('shows no part of the code at 64 columns or below 70', () => {
    for (const columns of [64, 69]) {
      const lines = codeScreenLines(shown(), columns, 40);
      const all = lines.join('');
      expect(all).not.toContain(JOIN_CODE.slice(10, 30));
      expect(all).not.toContain(JOIN_CODE.slice(-20));
      expect(lines.join(' ')).toContain('Widen the window to show the code: it needs at least 70 columns');
      expect(lines.join(' ')).toContain(`this one has ${columns} columns and 40 rows.`);
      for (const l of lines) expect(l.length).toBeLessThanOrEqual(columns - 1);
    }
  });

  it('shows no part of the code when the window has too few rows for every line', () => {
    const full = codeScreenLines(shown(), 80, 60);
    const need = full.length + 1;
    expect(codeScreenLines(shown(), 80, need)).toEqual(full);
    const short = codeScreenLines(shown(), 80, need - 1);
    expect(short.join('')).not.toContain(JOIN_CODE.slice(10, 30));
    expect(short.join(' ')).toContain(`it needs at least 70 columns and ${need} rows`);
    expect(codeScreenLines(shown(), 80, 8).join('')).not.toContain(JOIN_CODE.slice(-20));
  });
});

describe('m5 the join code texts', () => {
  it('a refusal is the route error, or the page text when it names none; no answer is the page text with the reason', () => {
    expect(joinCodeFailure({ ok: false, text: 'Bot not found' })).toBe('Bot not found');
    expect(joinCodeFailure({ ok: false, text: '' })).toBe('No join code was made');
    expect(joinCodeFailure({ ok: null, text: 'the manager did not answer within 15 s' }))
      .toBe('No answer from the manager (the manager did not answer within 15 s); the join code may still be running. Check its state before trying again.');
  });
});

describe('m5 the code field', () => {
  it('drops whitespace, line breaks, tabs and side bars from a pasted code', () => {
    const f = new CodeField();
    const lines = codeLines(JOIN_CODE);
    f.add(lines.map((l) => `| ${l}  |`).join('\r\n') + '\n');
    expect(f.text).toBe(JOIN_CODE);
    expect(stripCode(' a\tb c d\x0be\x0cf|g\x00h\x7f ')).toBe('abcdefgh');
  });

  it('shows asterisks only, then the length and the prefix of a join or move code', () => {
    const f = new CodeField();
    f.add(JOIN_CODE);
    const [box, note] = f.lines(40);
    expect(box).toMatch(/^\[\*+\s*\]$/);
    expect(box).not.toContain('smdb');
    expect(note).toBe(`${JOIN_CODE.length} characters, starts with smdbjoin1.`);
    expect(f.lines(40).join('')).not.toContain(JOIN_CODE.slice(10, 20));
    expect(codeFieldNote(MOVE_CODE)).toBe(`${MOVE_CODE.length} characters, starts with smdbmove1.`);
    expect(codeFieldNote('abc')).toBe('3 characters; a code starts with smdbjoin1. or smdbmove1.');
    expect(codeFieldNote('x')).toBe('1 character; a code starts with smdbjoin1. or smdbmove1.');
    expect(new CodeField().lines(20)).toEqual(['[                  ]']);
  });

  it('typing adds, Backspace removes the last character, Enter reports and keeps the text, Esc clears it', () => {
    const f = new CodeField();
    expect(f.key('smdb', {})).toBe('taken');
    expect(f.key(' x|', {})).toBe('taken');
    expect(f.text).toBe('smdbx');
    expect(f.key('', { backspace: true })).toBe('taken');
    expect(f.key('', { delete: true })).toBe('taken');
    expect(f.text).toBe('smd');
    expect(f.key('\r', { return: true })).toBe('enter');
    expect(f.text).toBe('smd');
    for (const k of [{ upArrow: true }, { tab: true }, { leftArrow: true }, { ctrl: true }, { pageDown: true }]) expect(f.key('', k)).toBeNull();
    expect(f.text).toBe('smd');
    expect(f.key('', { escape: true })).toBe('escape');
    expect(f.text).toBe('');
  });
});

describe('m5 the paste reader', () => {
  const readAll = (chunks: string[]) => {
    const r = new PasteReader();
    return { out: chunks.map((c) => r.read(c)), r };
  };

  it('plain keys are keys, Esc included; a lone carriage return is a key', () => {
    const { out } = readAll(['a', '\x1b', '\r', '\x1b[B']);
    expect(out).toEqual([{ key: true, text: '' }, { key: true, text: '' }, { key: true, text: '' }, { key: true, text: '' }]);
  });

  it('the markers and the text between them are no keys; the text is the paste', () => {
    const { out, r } = readAll([START, 'smdbjoin1.ab', '\r', 'cy', END, 'q']);
    expect(out.map((o) => o.key)).toEqual([false, false, false, false, false, true]);
    expect(out.map((o) => o.text).join('')).toBe('smdbjoin1.ab\rcy');
    expect(r.pasting).toBe(false);
  });

  it('a paste in one chunk with its markers', () => {
    const { out } = readAll([`${START}abc\r\ndef${END}`]);
    expect(out).toEqual([{ key: false, text: 'abc\r\ndef' }]);
  });

  it('markers split across chunks are joined, and no part of them is a key', () => {
    const { out, r } = readAll(['\x1b[', '20', '0~abc', 'de\x1b[2', '01~']);
    expect(out.map((o) => o.key)).toEqual([false, false, false, false, false]);
    expect(out.map((o) => o.text).join('')).toBe('abcde');
    expect(r.pasting).toBe(false);
    const again = readAll([START + 'xy\x1b', '[201', '~']);
    expect(again.out.map((o) => o.text).join('')).toBe('xy');
    expect(again.r.pasting).toBe(false);
    expect(again.r.read('j')).toEqual({ key: true, text: '' });
  });

  it('a held start that turns out not to be a marker: the read completing it is no key, the next key acts', () => {
    const r = new PasteReader();
    expect(r.read('\x1b[2')).toEqual({ key: false, text: '' });
    expect(r.read('j')).toEqual({ key: false, text: '' });
    expect(r.read('j')).toEqual({ key: true, text: '' });
    expect(r.pasting).toBe(false);
  });

  it('an arrow key split after ESC [ does not act as its final letter', () => {
    const r = new PasteReader();
    expect(r.read('\x1b[')).toEqual({ key: false, text: '' });
    expect(r.read('B')).toEqual({ key: false, text: '' });
    expect(r.read('\x1b[B')).toEqual({ key: true, text: '' });
    expect(r.read('\x1b[')).toEqual({ key: false, text: '' });
    expect(r.read('1;5A')).toEqual({ key: false, text: '' });
    expect(r.read('a')).toEqual({ key: true, text: '' });
  });
});
