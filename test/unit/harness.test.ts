import { describe, expect, it } from 'vitest';
import { isReservedName, resolveNames, sanitizeName } from '../../src/naming';

describe('the harness runs manager src', () => {
  it('resolves the three name layers from a display name', () => {
    expect(resolveNames('My Custom Bot!')).toEqual({
      displayName: 'My Custom Bot!',
      sanitizedName: 'mycustombot',
      titleName: 'My Custom Bot',
    });
  });

  it('names a display name with no letters or digits unnamed', () => {
    expect(sanitizeName('!!! ???')).toBe('unnamed');
    expect(resolveNames('!!!').titleName).toBe('Unnamed');
  });

  it('tells a reserved name from a free one', () => {
    expect(isReservedName(sanitizeName('Postgres'))).toBe(true);
    expect(isReservedName(sanitizeName('My Custom Bot!'))).toBe(false);
  });
});
