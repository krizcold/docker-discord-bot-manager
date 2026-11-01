import { describe, expect, it } from 'vitest';
import { URL_FORM, databaseHostIn, hasHostParam, namesDatabaseOf, readDatabaseUrl } from '../../src/config/databaseUrl';
import { parseFenceOwner } from '../../src/instance/fleetBackupGuards';
import type { InstanceConfig } from '../../src/types';

const form = (v: unknown, env: Record<string, string | undefined> = {}) => readDatabaseUrl(v as string, env).form;
const bot = (containerName: string, replication?: { publicHost?: string; hostPort?: number }) =>
  ({ id: containerName, fleetDb: { containerName, replication } } as unknown as InstanceConfig);

describe('the D88 form texts', () => {
  it('names each form in the words the operator reads', () => {
    expect(URL_FORM.scheme).toEqual({ what: 'holds an address that does not start with postgresql:// or postgres://', instead: 'write it as postgresql://user:password@host:port/database' });
    expect(URL_FORM.unparsed).toEqual({ what: 'holds a postgresql:// address the manager cannot parse', instead: 'write it as postgresql://user:password@host:port/database' });
    expect(URL_FORM.noHost).toEqual({ what: 'names no host', instead: 'write the host after the @' });
  });
});

describe('readDatabaseUrl', () => {
  it('reads an empty value or a join code as no address', () => {
    expect(readDatabaseUrl(undefined as unknown as string)).toEqual({ addresses: [], form: null });
    expect(readDatabaseUrl('smdbjoin1.abc')).toEqual({ addresses: [], form: null });
  });
  it('takes the scheme only at the start', () => {
    expect(form('xpostgresql://h/d')).toBe('scheme');
    expect(form('abc')).toBe('scheme');
  });
  it('drops the brackets of an IPv6 host', () => {
    expect(readDatabaseUrl('postgresql://u@[::1]:5433/d').addresses).toEqual([{ host: '::1', port: 5433, db: 'd' }]);
  });
  it('trims the value before reading the whole address', () => {
    expect(form('\u00A0postgresql://a/d?x=,postgresql://b/e&host=y')).toBe('param');
  });
  it('finds each form when only one of several addresses has it', () => {
    expect(form('postgresql://a/d,postgresql://[bad/d')).toBe('unparsed');
    expect(form('postgresql://a:5432,postgresql://b:5432/e?host=c')).toBe('param');
    expect(form('postgresql://a%41/d,postgresql://b/e')).toBe('encodedHost');
    expect(form('postgresql://a/d,postgresql:///e')).toBe('noHost');
    expect(form('postgresql://a/d,postgresql://b')).toBe('noDatabase');
    expect(form('postgresql://a/d,postgresql://b/e%41')).toBe('databaseName');
    expect(form('postgresql://a:5432/d,postgresql://b/e', { PGPORT: '5433' })).toBe('pgport');
    expect(form('postgresql://a:5432/d,postgresql://b:5432/e', { PGPORT: '5433' })).toBe(null);
  });
  it('reads a blank PGPORT as unset', () => {
    expect(form('postgresql://a/d', { PGPORT: '  ' })).toBe(null);
  });
});

describe('hasHostParam', () => {
  it('finds a hostaddr parameter', () => {
    expect(hasHostParam('postgresql://a/d?hostaddr=1.2.3.4')).toBe(true);
  });
  it('trims the value before reading the whole address', () => {
    expect(hasHostParam('\u00A0postgresql://a/d?x=,postgresql://b/e&host=y')).toBe(true);
  });
  it('finds the parameter when one address of several has it', () => {
    expect(hasHostParam('postgresql://a/d?host=b,postgresql://c/e')).toBe(true);
  });
});

describe('namesDatabaseOf', () => {
  it('needs the replication host to match', () => {
    expect(namesDatabaseOf({ host: 'x', port: 5432, db: 'd' }, { containerName: 'c', replication: { publicHost: 'y', hostPort: 5432 } })).toBe(false);
  });
  it('drops only a leading [ and a trailing ] from the replication host', () => {
    expect(namesDatabaseOf({ host: 'ab', port: 5432, db: 'd' }, { containerName: 'c', replication: { publicHost: 'a[b', hostPort: 5432 } })).toBe(false);
    expect(namesDatabaseOf({ host: 'ab', port: 5432, db: 'd' }, { containerName: 'c', replication: { publicHost: 'a]b', hostPort: 5432 } })).toBe(false);
  });
});

describe('databaseHostIn', () => {
  it('reads a host:port/db text', () => {
    const b = bot('c');
    expect(databaseHostIn('  c:5432', [b])).toBe(b);
    expect(databaseHostIn('c', [b])).toBe(b);
    expect(databaseHostIn('c:5432', [b])).toBe(b);
    expect(databaseHostIn('/c:5432', [b])).toBe(null);
  });
  it('reads a bracketed host', () => {
    const b = bot('::1');
    expect(databaseHostIn('[::1]:5432', [b])).toBe(b);
  });
  it('names no bot for an empty address', () => {
    expect(databaseHostIn(undefined as unknown as string, [bot('stryker was here!')])).toBe(null);
  });
});

describe('parseFenceOwner', () => {
  it('reads an owner only when the epoch ends the text', () => {
    expect(parseFenceOwner('restore:123')).toBe('restore:123');
    expect(parseFenceOwner('restore:123x')).toBe(null);
  });
});
