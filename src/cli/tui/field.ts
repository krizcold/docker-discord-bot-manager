/** A one-line text field: the text and the cursor position in it. */
export interface Field {
  text: string;
  cursor: number;
}

/** The parts of Ink's key object a field reads. */
export interface FieldKey {
  leftArrow?: boolean;
  rightArrow?: boolean;
  home?: boolean;
  end?: boolean;
  backspace?: boolean;
  delete?: boolean;
  ctrl?: boolean;
  meta?: boolean;
  upArrow?: boolean;
  downArrow?: boolean;
  tab?: boolean;
  return?: boolean;
  escape?: boolean;
}

export function field(text = ''): Field {
  return { text, cursor: text.length };
}

// Ink reports both the Backspace key's 0x7f and the Delete key's ESC [3~ as `delete`; only the raw sequence tells them apart.
export function isForwardDelete(raw: string | undefined): boolean {
  return !!raw && /^\x1b\[3[~;$^]/.test(raw);
}

const CONTROL = /[\x00-\x1f\x7f]/g;

/** The field after one key, or null when the key is not one a field takes (the caller handles it). */
export function editField(f: Field, input: string, key: FieldKey, forwardDelete = false): Field | null {
  const { text, cursor } = f;
  if (key.leftArrow) return { text, cursor: Math.max(0, cursor - 1) };
  if (key.rightArrow) return { text, cursor: Math.min(text.length, cursor + 1) };
  if (key.home) return { text, cursor: 0 };
  if (key.end) return { text, cursor: text.length };
  if (key.delete && forwardDelete) {
    return cursor < text.length ? { text: text.slice(0, cursor) + text.slice(cursor + 1), cursor } : f;
  }
  if (key.backspace || key.delete) {
    return cursor > 0 ? { text: text.slice(0, cursor - 1) + text.slice(cursor), cursor: cursor - 1 } : f;
  }
  if (key.ctrl || key.escape || key.tab || key.return || key.upArrow || key.downArrow) return null;
  // A pasted line arrives as one input; its line break and other control characters are dropped.
  const typed = input.replace(CONTROL, '');
  if (!typed) return null;
  return { text: text.slice(0, cursor) + typed + text.slice(cursor), cursor: cursor + typed.length };
}

/** The field as shown in `width` columns between brackets; a masked field shows one asterisk per character. */
export function showField(f: Field, width: number, mask = false): { text: string; col: number } {
  const room = Math.max(width - 2, 1);
  const shown = mask ? '*'.repeat(f.text.length) : f.text;
  const start = Math.max(0, f.cursor - room + 1);
  return { text: `[${shown.slice(start, start + room).padEnd(room)}]`, col: 1 + f.cursor - start };
}
