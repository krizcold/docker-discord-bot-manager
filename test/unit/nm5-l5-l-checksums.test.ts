import { describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ answer: null as any }));
vi.mock('../../src/instance/appHookClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/instance/appHookClient')>()),
  hasAppHooks: () => true,
  callAppHook: async () => h.answer,
}));

import { CHECKSUM_SQL, compareChecksums, parseChecksumLines } from '../../src/instance/backupFiles';
import { notifyOwner } from '../../src/instance/backupCheck';

const MD5 = '0123456789abcdef0123456789abcdef';

describe('CHECKSUM_SQL picks the permanent tables of COUNTS_SQL', () => {
  it.each([
    "(xpath('/row/h/text()', query_to_xml(format('SELECT md5(coalesce(string_agg(md5(t::text), '''' ORDER BY md5(t::text)), '''')) AS h FROM %I.%I t', n.nspname, c.relname), false, true, '')))[1]::text ",
    'FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace ',
    "WHERE c.relkind = 'r' AND c.relpersistence = 'p' AND n.nspname NOT IN ('pg_catalog', 'information_schema') ",
    "AND n.nspname NOT LIKE 'pg\\_toast%' AND n.nspname NOT LIKE 'pg\\_temp%' ",
    "AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'e') ",
  ])('holds %s', (part) => {
    expect(CHECKSUM_SQL).toContain(part);
  });
  it('ends with the name order', () => {
    expect(CHECKSUM_SQL.endsWith('ORDER BY n.nspname, c.relname')).toBe(true);
  });
});

describe('parseChecksumLines', () => {
  it('drops only a trailing carriage return', () => {
    expect(parseChecksumLines(`checksum|"a\rb"|${MD5}\r\n`)).toEqual({ ok: true, sums: { '"a\rb"': MD5 } });
  });
  it.each([`zz${MD5}`, `${MD5}zz`])('refuses a value that is not exactly an md5: %s', (v) => {
    expect(parseChecksumLines(`checksum|"s"."t"|${v}`)).toEqual({ ok: false, error: `a table checksum read back as checksum|"s"."t"|${v}` });
  });
  it('quotes at most 200 characters of the bad line', () => {
    const line = `checksum|"s"."${'t'.repeat(300)}"|bad`;
    expect(parseChecksumLines(line)).toEqual({ ok: false, error: `a table checksum read back as ${line.slice(0, 200)}` });
  });
});

describe('compareChecksums names the first difference by table name', () => {
  it('a table missing on the other side', () => {
    expect(compareChecksums({ '"s"."b"': MD5, '"s"."a"': MD5 }, {})).toEqual({ ok: false, text: '"s"."a" is missing on the other side' });
  });
  it('a table missing here', () => {
    expect(compareChecksums({}, { '"s"."b"': MD5, '"s"."a"': MD5 })).toEqual({ ok: false, text: '"s"."a" is not in this database' });
  });
});

describe('notifyOwner without an error text from the hook client', () => {
  it('a 404', async () => {
    h.answer = { ok: false, status: 404 };
    expect(await notifyOwner({ id: 'a', displayName: 'a', appHooks: true } as any, 'text', 'k')).toMatchObject({ dm: 'failed', dmError: 'notify-owner returned 404', notFound: true });
  });
  it('no answer', async () => {
    h.answer = { ok: false, status: 502, unknown: true };
    expect(await notifyOwner({ id: 'a', displayName: 'a', appHooks: true } as any, 'text', 'k')).toEqual({ dm: 'unknown', dmError: 'notify-owner did not answer' });
  });
});
