import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// NM20 L5 writer c: rows for the survivors in src/instance/dbLogin.ts (runCall, the roles read, its parsers,
// checkRolesDrift and provisionRoles' scripts and texts).
type Call = { args: string[]; input?: string; opts?: any };
type Answer = { err?: boolean; killed?: boolean; stdout?: string; stderr?: string };
const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm20-l5-c-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return {
    calls: [] as Array<{ args: string[]; input?: string; opts?: any }>,
    answer: (_c: { args: string[]; input?: string }): { err?: boolean; killed?: boolean; stdout?: string; stderr?: string } => ({ stdout: '' }),
    exec: null as null | ((args: string[], opts: any, cb: (e: any, out: any, err: any) => void) => void),
    start: null as null | ((args: string[]) => any),
  };
});
vi.mock('../../src/webui/server', () => ({ broadcastToClients: () => {} }));
vi.mock('../../src/docker/processStart', () => {
  const { EventEmitter } = require('events') as typeof import('events');
  const { PassThrough } = require('stream') as typeof import('stream');
  return {
    execFileGuarded: (cmd: string, args: string[], opts: any, cb: (e: any, out: any, err: any) => void) => {
      if (h.exec) return h.exec(args, opts, cb);
      const call = { args: [cmd, ...args], opts };
      h.calls.push(call);
      const a = h.answer(call);
      setImmediate(() => cb(a.err || a.killed ? Object.assign(new Error('exit 1'), { killed: !!a.killed, code: 1 }) : null, a.stdout ?? '', a.stderr ?? ''));
    },
    startProcess: (cmd: string, args: string[]) => {
      if (h.start) return h.start(args);
      const child: any = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => {};
      const stdin = new PassThrough();
      let input = '';
      stdin.on('data', (d: Buffer) => { input += d.toString(); });
      stdin.on('finish', () => {
        const call = { args: [cmd, ...args], input };
        h.calls.push(call);
        const a = h.answer(call);
        setImmediate(() => {
          if (a.stdout) child.stdout.emit('data', a.stdout);
          if (a.stderr) child.stderr.emit('data', a.stderr);
          child.emit('close', a.err ? 1 : 0);
        });
      });
      child.stdin = stdin;
      return { child };
    },
  };
});
vi.mock('../../src/docker/containerManager', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/docker/containerManager')>()),
  updateInstanceFleetDbPassword: (botId: string) => ({ id: botId } as any),
}));

import { EventEmitter } from 'events';
import {
  checkRolesDrift, clusterPsql, databaseResetSql, isRolesConfirmed, metaPsql, parseDriftRead, parseRolesRead, provisionRoles,
  resetManagerRoleCache, rolesReadSql, runCall,
} from '../../src/instance/dbLogin';

const C = 'b1-fleet-postgres';
const U = 'smdb';
const DB = 'smdb';
const SET_UP = 'false|false|false|true|false|true|ok|ok|ok|ok|ok|ok|4';
const fields = (over: Record<number, string>) => SET_UP.split('|').map((v, i) => (i in over ? over[i] : v)).join('|');

let rolesReads: string[] = [];
let schemaReads: string[] = [];
let failOn: RegExp | null = null;
const sqlOf = (c: Call) => c.input ?? c.args[c.args.length - 1];
const writes = () => h.calls.filter(c => c.input !== undefined).map(c => c.input as string);

function cluster(c: Call): Answer {
  const sql = sqlOf(c);
  if (failOn && failOn.test(sql)) return { err: true, stderr: `ERROR:  boom record-pw-1234\n` };
  if (sql.includes('pg_catalog.pg_is_in_recovery()::text,')) return { stdout: `${rolesReads.length > 1 ? rolesReads.shift() : rolesReads[0]}\n` };
  if (sql.includes("'owner|'")) return { stdout: `${schemaReads.length > 1 ? schemaReads.shift() : schemaReads[0]}\n` };
  if (sql.includes("'drift|'")) return { stdout: 'drift|0|0|0\n' };
  return { stdout: '' };
}

const target = (over: Partial<Parameters<typeof provisionRoles>[0]> = {}) =>
  ({ container: C, user: U, db: DB, botId: 'b1', password: 'record-pw-1234', candidates: [], ...over });

beforeEach(() => {
  h.calls.length = 0;
  h.exec = null;
  h.start = null;
  h.answer = cluster;
  rolesReads = [SET_UP];
  schemaReads = ['owner|dbm_meta|ok'];
  failOn = null;
  resetManagerRoleCache();
});
afterEach(() => { vi.useRealTimers(); });

describe('databaseResetSql', () => {
  it('doubles a quote inside the database name', () => {
    expect(databaseResetSql('a"b')).toContain('ALTER DATABASE "a""b" IS_TEMPLATE false;');
  });
});

describe('runCall', () => {
  it('passes the timeout to execFile and reads an undefined stdout and stderr as empty', async () => {
    let seen: any;
    h.exec = (_args, opts, cb) => { seen = opts; setImmediate(() => cb(null, undefined, undefined)); };
    const r = await runCall(C, clusterPsql(C, 'SELECT 1'), 1234);
    expect(seen).toEqual({ timeout: 1234 });
    expect(r).toEqual({ ok: true, stdout: '', stderr: '' });
  });

  it('a spawn that fails early answers its start error and nothing else', async () => {
    h.start = () => ({ child: undefined, error: 'spawn docker EMFILE' });
    const r = await runCall(C, clusterPsql(C, 'SELECT 1', { stdin: true }));
    expect(r).toEqual({ ok: false, stdout: '', stderr: 'spawn docker EMFILE', error: 'spawn docker EMFILE' });
  });

  it('collects the stdout of a script call', async () => {
    h.answer = () => ({ stdout: 'a|b\n' });
    const r = await runCall(C, clusterPsql(C, 'SELECT 1', { stdin: true }));
    expect(r).toEqual({ ok: true, stdout: 'a|b\n', stderr: '' });
  });

  it('a script call that fails with no message says docker exec failed', async () => {
    h.answer = () => ({ err: true });
    const r = await runCall(C, clusterPsql(C, 'SELECT 1', { stdin: true }));
    expect(r).toEqual({ ok: false, stdout: '', stderr: 'docker exec failed', error: 'docker exec failed' });
  });

  it('a child error followed by its close answers the error message', async () => {
    h.start = () => {
      const child: any = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.stdin = null;
      child.kill = () => true;
      setImmediate(() => {
        if (child.listenerCount('error')) child.emit('error', new Error('spawn docker ENOENT'));
        child.emit('close', -2);
      });
      return { child };
    };
    const r = await runCall(C, clusterPsql(C, 'SELECT 1', { stdin: true }));
    expect(r).toEqual({ ok: false, stdout: '', stderr: 'spawn docker ENOENT', error: 'spawn docker ENOENT' });
  });

  it('kills a script call at its deadline and says docker did not answer; a settled call is never killed', async () => {
    vi.useFakeTimers();
    let kills = 0;
    let closeNow = false;
    h.start = () => {
      const child: any = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.stdin = null;
      child.kill = () => { kills++; child.emit('close', null); return true; };
      if (closeNow) setTimeout(() => child.emit('close', 0), 10);
      return { child };
    };
    const p = runCall(C, clusterPsql(C, 'SELECT 1', { stdin: true }), 500);
    await vi.advanceTimersByTimeAsync(600);
    expect(kills).toBe(1);
    expect(await p).toEqual({ ok: false, stdout: '', stderr: 'docker did not answer within 0.5 s', error: 'docker did not answer within 0.5 s' });

    kills = 0;
    closeNow = true;
    const q = runCall(C, clusterPsql(C, 'SELECT 1', { stdin: true }), 500);
    await vi.advanceTimersByTimeAsync(600);
    expect(await q).toEqual({ ok: true, stdout: '', stderr: '' });
    expect(kills).toBe(0);
  });
});

describe('rolesReadSql', () => {
  it('names the pinned path, the allowed and needed memberships, the four roles and the three grants', () => {
    const sql = rolesReadSql(U, DB);
    expect(sql).toContain("s.setconfig = ARRAY['search_path=pg_catalog, pg_temp']::text[]");
    expect(sql).toContain("'search_path=pg_catalog, pg_temp' = ANY (s.setconfig)");
    expect(sql).toContain("p NOT IN ('dbm_meta>pg_read_all_stats', 'dbm_meta>pg_use_reserved_connections', 'dbm_work>smdb', 'dbm_work>pg_use_reserved_connections', 'smdb_receive>dbm_work', 'smdb_receive_meta>dbm_meta', 'smdb_receive_meta>smdb')");
    expect(sql).toContain("(VALUES (0, 'dbm_meta>pg_read_all_stats'), (1, 'dbm_meta>pg_use_reserved_connections'), (2, 'dbm_work>smdb'), (3, 'dbm_work>pg_use_reserved_connections')) v(n, p)");
    expect(sql).toContain("IN ('smdb', 'dbm_admin', 'dbm_meta', 'dbm_work')");
    expect(sql).toContain("coalesce((SELECT CASE WHEN a.rolsuper OR a.rolcreatedb");
    expect(sql).toContain("FROM pg_catalog.pg_authid a WHERE a.rolname = 'dbm_meta'), 'missing')");
    expect(sql).toContain("FROM pg_catalog.pg_authid a WHERE a.rolname = 'dbm_work'), 'missing')");
    expect(sql).toContain("SELECT pg_catalog.pg_get_userbyid(m.member)::text || '>' || pg_catalog.pg_get_userbyid(m.roleid)::text AS p");
    expect(sql).toContain("pg_catalog.has_database_privilege('dbm_meta', 'smdb', 'CONNECT')");
    expect(sql).toContain("pg_catalog.has_database_privilege('dbm_meta', 'smdb', 'CREATE')");
    expect(sql).toContain("pg_catalog.has_database_privilege('dbm_work', 'smdb', 'CONNECT')");
  });
});

describe('parseRolesRead', () => {
  it('refuses a membership that is not a whole plain pair', () => {
    expect(parseRolesRead(fields({ 8: '1a>b' }))).toBeNull();
    expect(parseRolesRead(fields({ 8: 'a>b,1c>d' }))).toBeNull();
    expect(parseRolesRead(fields({ 8: 'a>b' }))?.members).toEqual(['a>b']);
  });
  it('refuses a garbled bot rights field and a missing role read as the first role', () => {
    expect(parseRolesRead(fields({ 1: 'junk', 3: 'other' }))).toBeNull();
    expect(parseRolesRead(fields({ 1: 'missing', 2: 'true', 3: 'other' }))).toBeNull();
    expect(parseRolesRead(fields({ 1: 'missing', 3: 'other' }))?.botRights).toBeNull();
  });
});

describe('parseDriftRead', () => {
  it('reads whole counts and only an anchored line', () => {
    expect(parseDriftRead('drift|10|20|30\n')).toEqual({ settings: 10, loginSettings: 20, logins: 30 });
    expect(parseDriftRead('xdrift|0|0|0')).toBeNull();
    expect(parseDriftRead('drift|0|0|\n0')).toBeNull();
  });
});

describe('checkRolesDrift', () => {
  it('a database name that is not plain drops the confirmed container without a call', async () => {
    expect(await provisionRoles(target())).toMatchObject({ ok: true });
    expect(isRolesConfirmed(C)).toBe(true);
    h.calls.length = 0;
    expect(await checkRolesDrift({ container: C, db: 'Bad-Db' })).toBe(false);
    expect(h.calls).toEqual([]);
    expect(isRolesConfirmed(C)).toBe(false);
  });
});

describe('provisionRoles', () => {
  it('redacts the record password from a failed read', async () => {
    failOn = /pg_is_in_recovery\(\)::text,/;
    const r = await provisionRoles(target());
    expect(r).toEqual({ ok: false, cls: 'other', error: 'reading the roles failed (ERROR:  boom ***)' });
  });

  it('accepts a schema read asking for the public usage grant and writes the schema', async () => {
    schemaReads = ['owner|dbm_meta|public-usage', 'owner|dbm_meta|ok'];
    const r = await provisionRoles(target());
    expect(r).toEqual({ ok: true, wrote: ['schema'], reserved: 4 });
  });

  it('refuses a schema read that is not one anchored line, quoting at most 200 characters', async () => {
    for (const bad of ['xowner|dbm_meta|ok', 'owner|dbm_meta|ok|junk', 'owner|dbm_meta|o\nk']) {
      resetManagerRoleCache();
      schemaReads = [bad];
      const r = await provisionRoles(target());
      expect(r).toMatchObject({ ok: false, cls: 'other' });
      expect((r as any).error.startsWith('creating the schema smdb_manager as dbm_meta failed (the schema read answered ')).toBe(true);
    }
    resetManagerRoleCache();
    schemaReads = [`  ${'x'.repeat(250)}`];
    const r = await provisionRoles(target());
    expect(r).toEqual({ ok: false, cls: 'other', error: `creating the schema smdb_manager as dbm_meta failed (the schema read answered ${'x'.repeat(200)})` });
  });

  it('grants pg_read_all_stats to dbm_meta unless it created dbm_meta in that role', async () => {
    rolesReads = [fields({ 7: 'missing', 9: 'dbm_meta>pg_read_all_stats' }), SET_UP];
    await provisionRoles(target());
    expect(writes().some(w => w.includes('GRANT "pg_read_all_stats" TO "dbm_meta"'))).toBe(true);

    h.calls.length = 0;
    resetManagerRoleCache();
    rolesReads = [fields({ 6: 'missing', 9: 'dbm_meta>pg_read_all_stats' }), SET_UP];
    await provisionRoles(target());
    expect(writes().some(w => w.includes('GRANT "pg_read_all_stats"'))).toBe(false);
    expect(writes().some(w => w.includes('CREATE ROLE dbm_meta LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS VALID UNTIL \'-infinity\' IN ROLE pg_read_all_stats;'))).toBe(true);
  });

  it('writes the database statements for template and limit', async () => {
    rolesReads = [fields({ 10: 'template,limit' }), SET_UP];
    await provisionRoles(target());
    const script = writes().join('');
    expect(script).toContain('ALTER DATABASE "smdb" IS_TEMPLATE false;\nALTER DATABASE "smdb" CONNECTION LIMIT -1;\n');
  });

  it('grants dbm_meta CONNECT and CREATE when either is missing', async () => {
    for (const g of ['meta-connect', 'meta-create']) {
      h.calls.length = 0;
      resetManagerRoleCache();
      rolesReads = [fields({ 11: g }), SET_UP];
      await provisionRoles(target());
      expect(writes().join('')).toContain('GRANT CONNECT, CREATE ON DATABASE "smdb" TO dbm_meta;\n');
    }
  });

  it('checks recovery, the first role and the database again on the read after the writes', async () => {
    rolesReads = [SET_UP, fields({ 0: 'true' })];
    expect(await provisionRoles(target())).toEqual({ ok: false, cls: 'in-recovery' });
    resetManagerRoleCache();
    rolesReads = [SET_UP, fields({ 2: 'true' })];
    expect(await provisionRoles(target())).toEqual({ ok: false, cls: 'other', error: "the bot's role smdb is this database's first role, which Postgres keeps a superuser; a database the manager creates now starts with dbm_admin as its first role, so the bot's role gets less than superuser rights only on a new install" });
    resetManagerRoleCache();
    rolesReads = [SET_UP, fields({ 3: 'nodb' })];
    expect(await provisionRoles(target())).toEqual({ ok: false, cls: 'other', error: 'the database smdb does not exist in this container' });
  });

  it('names what did not read back as set, listing each item', async () => {
    const cases: Array<[string[], string[], string]> = [
      [[SET_UP, SET_UP], ['owner|dbm_meta|ok', 'owner||ok'], 'the schema smdb_manager in smdb does not exist'],
      [[SET_UP, fields({ 9: 'dbm_work>smdb,dbm_work>pg_use_reserved_connections' })], ['owner|dbm_meta|ok'], 'a role membership the manager needs is missing (dbm_work>smdb, dbm_work>pg_use_reserved_connections)'],
      [[SET_UP, fields({ 10: 'template,limit' })], ['owner|dbm_meta|ok'], 'smdb still has an owner-made setting (template, limit)'],
      [[SET_UP, fields({ 11: 'meta-connect,work-connect' })], ['owner|dbm_meta|ok'], 'smdb does not grant meta-connect, work-connect'],
    ];
    for (const [roles, schema, text] of cases) {
      resetManagerRoleCache();
      rolesReads = roles;
      schemaReads = schema;
      expect(await provisionRoles(target())).toEqual({ ok: false, cls: 'other', error: `the roles did not read back as set (${text})` });
    }
  });
});
