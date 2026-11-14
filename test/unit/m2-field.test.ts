import { describe, expect, it } from 'vitest';
import { editField, field, isForwardDelete, showField } from '../../src/cli/tui/field';

describe('m2 text field', () => {
  it('moves the cursor left, right, home and end inside the text', () => {
    let f = field('abc');
    expect(f.cursor).toBe(3);
    f = editField(f, '', { leftArrow: true })!;
    f = editField(f, '', { leftArrow: true })!;
    expect(f.cursor).toBe(1);
    f = editField(f, '', { home: true })!;
    expect(editField(f, '', { leftArrow: true })!.cursor).toBe(0);
    f = editField(f, '', { end: true })!;
    expect(editField(f, '', { rightArrow: true })!.cursor).toBe(3);
  });

  it('inserts at the cursor, and backspace and delete remove on their side of it', () => {
    let f = editField(field('acd'), '', { leftArrow: true })!;
    f = editField(f, '', { leftArrow: true })!;
    f = editField(f, 'b', {})!;
    expect(f).toEqual({ text: 'abcd', cursor: 2 });
    f = editField(f, '', { backspace: true })!;
    expect(f).toEqual({ text: 'acd', cursor: 1 });
    f = editField(f, '', { delete: true }, true)!;
    expect(f).toEqual({ text: 'ad', cursor: 1 });
    // Ink names the Backspace key's 0x7f "delete"; without the Delete key's sequence it removes backwards.
    f = editField(f, '', { delete: true }, false)!;
    expect(f).toEqual({ text: 'd', cursor: 0 });
    expect(editField(f, '', { backspace: true })).toEqual(f);
    expect(editField(field('x'), '', { delete: true }, true)).toEqual({ text: 'x', cursor: 1 });
  });

  it('takes a pasted line whole and drops its line break and control characters', () => {
    const f = editField(field('k='), 'https://example.org/a b\r\n', {})!;
    expect(f).toEqual({ text: 'k=https://example.org/a b', cursor: 25 });
    expect(editField(f, '\u0007', {})).toBeNull();
  });

  it('leaves keys that move between fields to the caller', () => {
    for (const key of [{ tab: true }, { return: true }, { escape: true }, { upArrow: true }, { downArrow: true }, { ctrl: true }]) {
      expect(editField(field('a'), key.ctrl ? 'n' : '', key)).toBeNull();
    }
  });

  it('tells the Delete key from Backspace by the raw sequence', () => {
    expect(isForwardDelete('\u001B[3~')).toBe(true);
    expect(isForwardDelete('\u007F')).toBe(false);
    expect(isForwardDelete('\b')).toBe(false);
    expect(isForwardDelete(undefined)).toBe(false);
  });

  it('shows asterisks for a masked field, never its text, and keeps the cursor in view', () => {
    const shown = showField(field('S3cretValue'), 8, true);
    expect(shown.text).toBe('[***** ]');
    expect(shown.text).not.toContain('S3cret');
    expect(shown.col).toBe(6);
    const plain = showField({ text: 'abcdefghij', cursor: 2 }, 8);
    expect(plain).toEqual({ text: '[abcdef]', col: 3 });
  });
});
