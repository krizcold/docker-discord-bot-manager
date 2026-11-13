import { describe, expect, it } from 'vitest';
import { metaTocGaps, parseQualifiedName } from '../../src/instance/backupFiles';
import { COUNTS_OF, TOC } from './restore-fake';

const HEAD = TOC.empty;

describe('parseQualifiedName', () => {
  it('F1 a plain name', () => {
    expect(parseQualifiedName('smdb_data.meta')).toEqual({ schema: 'smdb_data', table: 'meta' });
  });

  it('F2 quoted parts with a doubled quote, a dot and a space', () => {
    expect(parseQualifiedName('"we""ird.x"."a b"')).toEqual({ schema: 'we"ird.x', table: 'a b' });
  });

  it('F3 one part quoted, the other not', () => {
    expect(parseQualifiedName('"Up".t')).toEqual({ schema: 'Up', table: 't' });
    expect(parseQualifiedName('s."T"')).toEqual({ schema: 's', table: 'T' });
  });

  it.each(['a.b.c', 'a', '.a', 'a.', '"a.b', '"a"x.b', '""."b"', ''])('F4 %j is not a schema and table name', (name) => {
    expect(parseQualifiedName(name)).toBeNull();
  });
});

describe('metaTocGaps', () => {
  it('F5 the claims TOC holds every table its counts name', () => {
    expect(metaTocGaps(COUNTS_OF.claims, TOC.claims)).toEqual([]);
  });

  it('F6 a header-only TOC holds no recorded table', () => {
    expect(metaTocGaps({ 'smdb_data.meta': 1 }, TOC.empty)).toEqual(['smdb_data.meta: no table in the dump']);
  });

  it('F7 a header-only TOC with no recorded table', () => {
    expect(metaTocGaps({}, TOC.empty)).toEqual([]);
  });

  it('F8 a recorded table the TOC does not list', () => {
    expect(metaTocGaps({ 'smdb_data.meta': 0, 'smdb_data.other': 0 }, TOC.claims)).toEqual(['smdb_data.other: no table in the dump']);
  });

  it('F9 a table recorded with rows and no data entry', () => {
    const toc = TOC.claims.replace('3361; 0 16400 TABLE DATA smdb_data meta app\n', '');
    expect(toc).not.toBe(TOC.claims);
    expect(metaTocGaps({ 'smdb_data.meta': 4 }, toc)).toEqual(['smdb_data.meta: 4 row(s) recorded, no data in the dump']);
    expect(metaTocGaps({ 'smdb_data.meta': 0 }, toc)).toEqual([]);
  });

  it('F10 a table whose name starts with the recorded one is not a match', () => {
    expect(metaTocGaps({ 'smdb_data.meta': 0 }, `${HEAD}215; 1259 16400 TABLE smdb_data metadata app\n`)).toEqual(['smdb_data.meta: no table in the dump']);
  });

  it('F11 quoted names as pg_restore -l prints them', () => {
    const toc = `${HEAD}216; 1259 1 TABLE we"ird.x a b app\n3360; 0 1 TABLE DATA we"ird.x a b app\n`;
    expect(metaTocGaps({ '"we""ird.x"."a b"': 2 }, toc)).toEqual([]);
  });

  it('F12 a line break in a name reads as a space in the TOC', () => {
    const toc = `${HEAD}216; 1259 1 TABLE s line break app\n3360; 0 1 TABLE DATA s line break app\n`;
    expect(metaTocGaps({ 's."line\nbreak"': 2 }, toc)).toEqual([]);
  });

  it('F13 CRLF line ends and an empty owner', () => {
    expect(metaTocGaps({ 's.t': 1 }, `${HEAD}216; 1259 1 TABLE s t app\r\n3360; 0 1 TABLE DATA s t app\r\n`)).toEqual([]);
    expect(metaTocGaps({ 's.t': 1 }, `${HEAD}216; 1259 1 TABLE s t \n3360; 0 1 TABLE DATA s t \n`)).toEqual([]);
    expect(metaTocGaps({ 's.t': 1 }, `${HEAD}216; 1259 1 TABLE s t\n3360; 0 1 TABLE DATA s t\n`)).toEqual([]);
  });

  it('F14 a recorded name that does not parse', () => {
    expect(metaTocGaps({ 'a.b.c': 1 }, TOC.claims)).toEqual(['a.b.c: not a schema and table name']);
  });
});
