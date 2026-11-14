import { describe, expect, it } from 'vitest';
import { parseChecksumLines, parseCountLines } from '../../src/instance/backupFiles';

const MD5 = '0123456789abcdef0123456789abcdef';

describe('NM23 the count and checksum parsers undo the name escapes', () => {
  it.each([
    ['a line feed', '"s"."a\\nb"', '"s"."a\nb"'],
    ['a carriage return', '"s"."a\\rb"', '"s"."a\rb"'],
    ['a backslash', '"s"."a\\\\b"', '"s"."a\\b"'],
    ['all three', '"s\\\\"."\\r\\n\\\\n"', '"s\\"."\r\n\\n"'],
    ['nothing escaped', '"smdb_data"."b|c"', '"smdb_data"."b|c"'],
  ])('P1 %s', (_name, printed, key) => {
    const counts = parseCountLines(`snap|x\ncount|${printed}|4\ncount|"public"."t"|1\nend|\n`);
    expect(counts).toEqual({ ok: true, counts: { [key]: 4, '"public"."t"': 1 } });
    const sums = parseChecksumLines(`checksum|${printed}|${MD5}\r\n`);
    expect(sums).toEqual({ ok: true, sums: { [key]: MD5 } });
  });

  it.each([
    ['an unknown escape', '"s"."a\\tb"'],
    ['a trailing lone backslash', '"s"."ab"\\'],
  ])('P2 %s refuses the lot', (_name, printed) => {
    const counts = parseCountLines(`count|"public"."t"|1\ncount|${printed}|4\n`);
    expect(counts).toEqual({ ok: false, error: `a table count read back as count|${printed}|4` });
    const sums = parseChecksumLines(`checksum|"public"."t"|${MD5}\nchecksum|${printed}|${MD5}\n`);
    expect(sums).toEqual({ ok: false, error: `a table checksum read back as checksum|${printed}|${MD5}` });
  });

  it('P3 a raw line break inside a name still refuses the counts', () => {
    expect(parseCountLines('count|"s"."a\nb"|4\n').ok).toBe(false);
  });
});
