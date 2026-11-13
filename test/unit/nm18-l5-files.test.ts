import { describe, expect, it } from 'vitest';
import { metaTocGaps } from '../../src/instance/backupFiles';
import { TOC } from './restore-fake';

const HEAD = TOC.empty;

describe('NM18 L5 metaTocGaps', () => {
  it('G1 a stray carriage return inside a line is kept', () => {
    expect(metaTocGaps({ 's.t': 0 }, `${HEAD}216; 1259 1 TABLE s t\r app\n`)).toEqual(['s.t: no table in the dump']);
  });

  it('G2 a CRLF line with an empty owner and no trailing space', () => {
    expect(metaTocGaps({ 's.t': 1 }, `${HEAD}216; 1259 1 TABLE s t\r\n3360; 0 1 TABLE DATA s t\r\n`)).toEqual([]);
  });

  it('G4 gaps come in name order', () => {
    expect(metaTocGaps({ 's.b': 0, 's.a': 0 }, HEAD)).toEqual(['s.a: no table in the dump', 's.b: no table in the dump']);
  });

  it('G5 a line break in a schema name reads as a space in the TOC', () => {
    const toc = `${HEAD}216; 1259 1 TABLE line break t app\n3360; 0 1 TABLE DATA line break t app\n`;
    expect(metaTocGaps({ '"line\nbreak".t': 2 }, toc)).toEqual([]);
  });
});
