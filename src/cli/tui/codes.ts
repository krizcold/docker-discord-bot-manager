import { FieldKey, showField } from './field';
import { wrap } from './install';

/** A code line's length: inside 70 columns with room to spare, and the same in every terminal. */
export const CODE_LINE = 64;
export const CODE_MIN_COLUMNS = 70;
export const CODE_PREFIXES = ['smdbjoin1.', 'smdbmove1.'] as const;

export const PASTE_ON = '\x1b[?2004h';
export const PASTE_OFF = '\x1b[?2004l';
const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';

// index.html:2910 and the warning of copyJoinCode (:3065).
export const JOIN_CODE_NOTES = [
  'Other machines paste this code to use this database (a live copy, shards, or both).',
  'It holds database passwords: paste it only into your own managers.',
];

export const COPY_ADVICE = 'Select and copy every line of the code. The line breaks, and any spaces a terminal adds at the line ends, do no '
  + 'harm: the manager drops them when the code is pasted.';

/** What the code screen shows: its title, the code and the lines under it. */
export interface CodeShown {
  title: string;
  code: string;
  notes: string[];
  /** Called once a code screen has drawn the code whole. */
  onWhole?: () => void;
  /** When a move code was put in the Session, for a switch read sent after it. */
  heldAt?: number;
}

/**
 * fetchJoinCode (index.html:3049): a refusal is the route's error or the page's own text; no answer is the page's
 * showNoAnswer('join code') (:1398), with the reason.
 */
export function joinCodeFailure(r: { ok: false | null; text: string }): string {
  if (r.ok === null) return `No answer from the manager (${r.text}); the join code may still be running. Check its state before trying again.`;
  return r.text || 'No join code was made';
}

/** The code in lines of 64 characters, each starting at column 0 with nothing else on it. */
export function codeLines(code: string): string[] {
  const out: string[] = [];
  for (let at = 0; at < code.length; at += CODE_LINE) out.push(code.slice(at, at + CODE_LINE));
  return out;
}

function titleBar(title: string, width: number): string {
  const text = `+ ${title} `;
  return (text.length >= width - 1 ? text.slice(0, width - 1) : text + '-'.repeat(width - 1 - text.length)) + '+';
}

/**
 * The code screen in a terminal of `columns` by `rows`: the title bar, the code, the notes, its length and the bottom
 * bar. A wrapped or cut code copies wrong, so a terminal too narrow or too short for every line shows none of it.
 */
export function codeScreenLines(shown: CodeShown, columns: number, rows: number): string[] {
  return codeScreen(shown, columns, rows).lines;
}

/** The code screen's lines, and whether they hold the code whole. */
export function codeScreen(shown: CodeShown, columns: number, rows: number): { lines: string[]; whole: boolean } {
  // One column short of the edge, as the frame: some terminals wrap a line that fills the last column.
  const width = Math.max(columns - 1, 20);
  const top = titleBar(shown.title, width);
  const code = codeLines(shown.code);
  const size = `The code is ${shown.code.length} characters long, in ${code.length} ${code.length === 1 ? 'line' : 'lines'}.`;
  const notes = [...shown.notes, COPY_ADVICE, size].flatMap((l) => wrap(l, width));
  const lines = [top, ...code, '', ...notes, '', 'Esc Close'];
  // The frame leaves the terminal's last row empty, as M1's frame does.
  if (columns >= CODE_MIN_COLUMNS && lines.length <= rows - 1) return { lines, whole: true };
  const need = `Widen the window to show the code: it needs at least ${CODE_MIN_COLUMNS} columns and ${lines.length + 1} rows, and this `
    + `one has ${columns} columns and ${rows} rows.`;
  return { lines: [top, '', ...wrap(need, width), '', 'Esc Close'], whole: false };
}

/** A pasted or typed code without the whitespace and side bars a copy from a terminal can carry. */
export function stripCode(text: string): string {
  return text.replace(/[\s|\x00-\x1f\x7f]/g, '');
}

/** The line under a code field: its length and, when it is one of the two known kinds, its prefix (which is not secret). */
export function codeFieldNote(text: string): string {
  if (!text) return '';
  const prefix = CODE_PREFIXES.find((p) => text.startsWith(p));
  const n = `${text.length} ${text.length === 1 ? 'character' : 'characters'}`;
  return prefix ? `${n}, starts with ${prefix}` : `${n}; a code starts with ${CODE_PREFIXES.join(' or ')}`;
}

export type CodeKeyOutcome = 'enter' | 'escape' | 'taken' | null;

/**
 * A field for a join or move code. It drops whitespace and `|`, shows asterisks, and keeps its text until the action
 * that owns it clears it; Esc clears it. Enter is reported to the owner and never changes the text.
 */
export class CodeField {
  text = '';

  constructor(readonly hooks: { onEnter?: () => void; onEscape?: () => void } = {}) {}

  add(text: string): void {
    this.text += stripCode(text);
  }

  clear(): void {
    this.text = '';
  }

  /** One key: 'taken' when the field used it, null when it is not one the field takes (the screen handles it). */
  key(input: string, key: FieldKey & { pageUp?: boolean; pageDown?: boolean }): CodeKeyOutcome {
    if (key.escape) {
      this.clear();
      return 'escape';
    }
    if (key.return) return 'enter';
    if (key.backspace || key.delete) {
      this.text = this.text.slice(0, -1);
      return 'taken';
    }
    if (key.ctrl || key.meta || key.tab || key.upArrow || key.downArrow || key.leftArrow || key.rightArrow || key.home || key.end || key.pageUp || key.pageDown) {
      return null;
    }
    this.add(input);
    return 'taken';
  }

  /** The masked field in `width` columns and the line under it. */
  lines(width: number): string[] {
    const shown = showField({ text: this.text, cursor: this.text.length }, width, true).text;
    const note = codeFieldNote(this.text);
    return note ? [shown, note] : [shown];
  }
}

/** The longest end of `s` that is the start of `marker` (a marker split across two reads). */
function heldTail(s: string, marker: string): number {
  for (let n = Math.min(s.length, marker.length - 1); n > 0; n--) if (marker.startsWith(s.slice(s.length - n))) return n;
  return 0;
}

/**
 * Reads the terminal's input events for bracketed paste. `key` is false for a paste marker, the text between the
 * markers, a marker's held start and the read that completes a held start, so no key inside a paste acts; `text` is
 * the pasted text the event carried.
 */
export class PasteReader {
  pasting = false;
  private carry = '';

  read(data: string): { key: boolean; text: string } {
    let s = this.carry + data;
    // A held start completed by this read is an escape sequence split across reads (an arrow key, say): its tail is
    // never a key of its own, so a split ESC [ B does not act as the letter B.
    let key = !this.pasting && !this.carry;
    this.carry = '';
    let text = '';
    for (;;) {
      if (!this.pasting) {
        const at = s.indexOf(PASTE_START);
        if (at >= 0) {
          key = false;
          this.pasting = true;
          s = s.slice(at + PASTE_START.length);
          continue;
        }
        // A lone ESC is the Esc key; ESC [ and longer starts of the marker are never a key of their own.
        if (s.length >= 2 && s.length < PASTE_START.length && PASTE_START.startsWith(s)) {
          this.carry = s;
          key = false;
        }
        return { key, text };
      }
      key = false;
      const at = s.indexOf(PASTE_END);
      if (at >= 0) {
        text += s.slice(0, at);
        this.pasting = false;
        s = s.slice(at + PASTE_END.length);
        if (!s) return { key, text };
        continue;
      }
      const hold = heldTail(s, PASTE_END);
      text += s.slice(0, s.length - hold);
      this.carry = s.slice(s.length - hold);
      return { key, text };
    }
  }
}
