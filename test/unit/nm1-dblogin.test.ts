import { beforeEach, describe, expect, it, vi } from 'vitest';

type Answer = { err?: string; stdout?: string; stderr?: string };
const dk = vi.hoisted(() => ({
  calls: [] as Array<{ args: string[]; opts: any }>,
  answer: (_args: string[]): { err?: string; stdout?: string; stderr?: string } => ({ stdout: '' }),
}));
vi.mock('child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('child_process')>()),
  execFile: (cmd: string, args: string[], opts: any, cb: (e: Error | null, out: string, err: string) => void) => {
    dk.calls.push({ args: [cmd, ...args], opts });
    const a: Answer = dk.answer(args);
    setImmediate(() => cb(a.err ? Object.assign(new Error(a.err), { code: 1 }) : null, a.stdout ?? '', a.stderr ?? ''));
  },
}));

import { ensureManagerDbRole, readBotLogin, blockBotLogin, endBotSessions, openBotLogin, readWriteFence, resetManagerRoleCache, psqlFailureClass, MANAGER_DB_ROLE } from '../../src/instance/dbLogin';

const t = { container: 'b1-fleet-postgres', user: 'smdb' };
const READ_SQL = "SELECT pg_is_in_recovery()::text || '|' || coalesce((SELECT rolcanlogin::text FROM pg_roles WHERE rolname = 'smdb'), 'missing') || '|' || (SELECT count(*) FROM pg_stat_activity WHERE usename = 'smdb' AND backend_type = 'client backend')::text";
const argv = (role: string, sql: string) => ['docker', 'exec', 'b1-fleet-postgres', 'psql', '-U', role, '-d', 'postgres', '-tA', '-v', 'ON_ERROR_STOP=1', '-c', sql];
const exemptArgv = (role: string, sql: string) => ['docker', 'exec', '-e', 'PGOPTIONS=-c default_transaction_read_only=off', 'b1-fleet-postgres', 'psql', '-U', role, '-d', 'postgres', '-tA', '-v', 'ON_ERROR_STOP=1', '-c', sql];
const FENCE_SQL = "SELECT current_setting('default_transaction_read_only')";
const FENCE_OWNER_SQL = "SELECT coalesce(btrim(pg_read_file('smdb-fence-owner', true), E' \\n'), '') || '|' || (SELECT count(*) FROM pg_file_settings WHERE name = 'default_transaction_read_only')";
const sqlOf = (c: { args: string[] }) => c.args[c.args.length - 1];
const roleOf = (c: { args: string[] }) => c.args[c.args.indexOf('-U') + 1];

beforeEach(() => {
  dk.calls = [];
  resetManagerRoleCache();
});

describe('the exact argv and SQL of each function', () => {
  it('the manager role is dbm_admin', () => expect(MANAGER_DB_ROLE).toBe('dbm_admin'));

  it('readBotLogin', async () => {
    dk.answer = () => ({ stdout: 'false|false|0\n' });
    expect(await readBotLogin(t)).toEqual({ ok: true, login: { inRecovery: false, canLogin: false, sessions: 0 } });
    expect(dk.calls.map(c => c.args)).toEqual([argv('dbm_admin', READ_SQL)]);
    expect(dk.calls[0].opts.timeout).toBe(30_000);
  });

  it('readBotLogin fails closed on an unparsable answer', async () => {
    dk.answer = () => ({ stdout: 'false|true\n' });
    const r = await readBotLogin(t);
    expect(r.ok).toBe(false);
  });

  it('blockBotLogin reads first, then ALTER ROLE NOLOGIN in the fence-exempt session', async () => {
    dk.answer = () => ({ stdout: 'false|true|2\n' });
    expect(await blockBotLogin(t)).toEqual({ ok: true });
    expect(dk.calls.map(c => c.args)).toEqual([argv('dbm_admin', READ_SQL), exemptArgv('dbm_admin', 'ALTER ROLE "smdb" NOLOGIN')]);
  });

  it('readWriteFence reads the read-only default in a session that is not exempt', async () => {
    let owner = 'reseed:1793181600000|1\n';
    dk.answer = (args) => ({ stdout: args[args.length - 1] === FENCE_SQL ? 'on\n' : owner });
    expect(await readWriteFence(t)).toEqual({ ok: true, on: true, owner: 'reseed:1793181600000', persisted: true });
    owner = '|0\n';
    expect(await readWriteFence(t)).toEqual({ ok: true, on: true, owner: null, persisted: false });
    owner = 'garbled\n';
    expect(await readWriteFence(t)).toEqual({ ok: true, on: true, owner: null, persisted: null });
    expect(dk.calls.map(c => c.args).slice(0, 2)).toEqual([argv('dbm_admin', FENCE_SQL), argv('dbm_admin', FENCE_OWNER_SQL)]);
    dk.calls = [];
    dk.answer = () => ({ stdout: 'off\n' });
    expect(await readWriteFence(t)).toEqual({ ok: true, on: false });
    expect(dk.calls.map(c => c.args)).toEqual([argv('dbm_admin', FENCE_SQL)]);
    dk.answer = () => ({ stdout: 'maybe\n' });
    expect(await readWriteFence(t)).toMatchObject({ ok: false });
  });

  it('openBotLogin under the read-only layer of a main answers the write fence, not recovery', async () => {
    dk.answer = (args) => args[args.length - 1].startsWith('ALTER') ? { err: 'exit 1', stderr: 'ERROR:  cannot execute ALTER ROLE in a read-only transaction' } : { stdout: 'false|false|0\n' };
    expect(await openBotLogin(t)).toEqual({ ok: false, cls: 'write-fence', error: 'ERROR:  cannot execute ALTER ROLE in a read-only transaction' });
  });

  it('openBotLogin reads first, then ALTER ROLE LOGIN', async () => {
    dk.answer = () => ({ stdout: 'false|false|0\n' });
    expect(await openBotLogin(t)).toEqual({ ok: true });
    expect(dk.calls.map(c => c.args)).toEqual([argv('dbm_admin', READ_SQL), argv('dbm_admin', 'ALTER ROLE "smdb" LOGIN')]);
  });

  it('ensureManagerDbRole checks rolsuper as dbm_admin', async () => {
    dk.answer = () => ({ stdout: 'true\n' });
    expect(await ensureManagerDbRole(t)).toEqual({ ok: true });
    expect(dk.calls.map(c => c.args)).toEqual([argv('dbm_admin', 'SELECT rolsuper::text FROM pg_roles WHERE rolname = current_user')]);
  });

  it('a refused bot role name runs nothing', async () => {
    for (const fn of [readBotLogin, blockBotLogin, openBotLogin, ensureManagerDbRole]) {
      const r: any = await fn({ container: 'c', user: 'dbm_admin' });
      expect(r.ok).toBe(false);
    }
    const r: any = await endBotSessions({ container: 'c', user: 'replicator' }, 0);
    expect(r.ok).toBe(false);
    expect(dk.calls).toEqual([]);
  });
});

describe('ensureManagerDbRole', () => {
  const MISSING = 'psql: error: connection to server on socket "/var/run/postgresql/.s.PGSQL.5432" failed: FATAL:  role "dbm_admin" does not exist';
  it('present: one check, then cached for the container', async () => {
    dk.answer = () => ({ stdout: 'true\n' });
    await ensureManagerDbRole(t);
    expect(await ensureManagerDbRole(t)).toEqual({ ok: true });
    expect(dk.calls.length).toBe(1);
  });

  // NM20 3.3: the ensure checks only; dbm_admin is made by initdb as the first role, never over the bot role.
  const ROLE_MISSING = "the role dbm_admin does not exist in this database's cluster; the manager creates it only as the first role of a database it creates";
  it('missing: one check as dbm_admin, no CREATE, and ROLE-MISSING', async () => {
    dk.answer = (args) => (args[args.length - 1].startsWith('CREATE ROLE') ? { stdout: 'CREATE ROLE\n' } : { err: 'exit 2', stderr: MISSING });
    expect(await ensureManagerDbRole(t)).toEqual({ ok: false, cls: 'missing-role', error: ROLE_MISSING });
    expect(dk.calls.map(c => [roleOf(c), sqlOf(c)])).toEqual([
      ['dbm_admin', 'SELECT rolsuper::text FROM pg_roles WHERE rolname = current_user'],
    ]);
  });

  it('missing: nothing cached, so the next call checks again', async () => {
    dk.answer = () => ({ err: 'exit 2', stderr: MISSING });
    const r: any = await ensureManagerDbRole(t);
    expect(r.ok).toBe(false);
    expect(r.error).toBe(ROLE_MISSING);
    dk.calls = [];
    await ensureManagerDbRole(t);
    expect(dk.calls.length).toBeGreaterThan(0);
  });

  it('a role that appears between two checks is found by the next check', async () => {
    let n = 0;
    dk.answer = () => (n++ === 0 ? { err: 'exit 2', stderr: MISSING } : { stdout: 'true\n' });
    expect(await ensureManagerDbRole(t)).toMatchObject({ ok: false, cls: 'missing-role' });
    expect(await ensureManagerDbRole(t)).toEqual({ ok: true });
    expect(dk.calls.some(c => sqlOf(c).startsWith('CREATE'))).toBe(false);
  });

  it('a role that is not a superuser fails', async () => {
    dk.answer = () => ({ stdout: 'false\n' });
    const r: any = await ensureManagerDbRole(t);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/not a superuser/);
  });
});

describe('the block and the open refuse a database in recovery', () => {
  it('blockBotLogin in recovery sends no ALTER', async () => {
    dk.answer = () => ({ stdout: 'true|true|0\n' });
    expect(await blockBotLogin(t)).toMatchObject({ ok: false, cls: 'recovery' });
    expect(dk.calls.some(c => sqlOf(c).startsWith('ALTER'))).toBe(false);
  });
  it('openBotLogin in recovery sends no ALTER', async () => {
    dk.answer = () => ({ stdout: 'true|false|0\n' });
    expect(await openBotLogin(t)).toMatchObject({ ok: false, cls: 'recovery' });
    expect(dk.calls.some(c => sqlOf(c).startsWith('ALTER'))).toBe(false);
  });
  it('an ALTER that fails carries psql\'s last line', async () => {
    dk.answer = (args) => args[args.length - 1].startsWith('ALTER') ? { err: 'exit 1', stderr: 'some notice\nERROR:  permission denied to alter role' } : { stdout: 'false|true|0\n' };
    expect(await blockBotLogin(t)).toEqual({ ok: false, cls: 'other', error: 'ERROR:  permission denied to alter role' });
  });
});

describe('endBotSessions', () => {
  const TERM = "SELECT count(*) FROM (SELECT pg_terminate_backend(pid, 5000) FROM pg_stat_activity WHERE usename = 'smdb' AND backend_type = 'client backend' AND pid <> pg_backend_pid()) t";
  const sessions = (counts: number[]) => {
    let reads = 0;
    dk.answer = (args) => args[args.length - 1] === TERM ? { stdout: '1\n' } : { stdout: `false|false|${counts[Math.min(reads++, counts.length - 1)]}\n` };
  };
  it('0 at round 1', async () => {
    sessions([0]);
    expect(await endBotSessions(t, 0)).toEqual({ ok: true });
    expect(dk.calls.map(sqlOf)).toEqual([TERM, READ_SQL]);
  });
  it('0 at round 3', async () => {
    sessions([2, 1, 0]);
    expect(await endBotSessions(t, 0)).toEqual({ ok: true });
    expect(dk.calls.filter(c => sqlOf(c) === TERM).length).toBe(3);
  });
  it('sessions left after round 3', async () => {
    sessions([3, 2, 2]);
    expect(await endBotSessions(t, 0)).toMatchObject({ ok: false, left: 2 });
    expect(dk.calls.filter(c => sqlOf(c) === TERM).length).toBe(3);
  });
  it('the count and the terminate both name only client sessions, so the replication launcher is never counted', async () => {
    sessions([0]);
    expect(await endBotSessions(t, 0)).toEqual({ ok: true });
    const sql = dk.calls.map(sqlOf);
    expect(sql).toHaveLength(2);
    for (const s of sql) expect(s).toContain("FROM pg_stat_activity WHERE usename = 'smdb' AND backend_type = 'client backend'");
  });
  it('a recount that fails ends with that error', async () => {
    dk.answer = (args) => args[args.length - 1] === TERM ? { stdout: '1\n' } : { err: 'exit 2', stderr: 'boom' };
    expect(await endBotSessions(t, 0)).toMatchObject({ ok: false, error: 'boom' });
  });
});

describe('stderr classes', () => {
  it.each([
    ['psql: error: FATAL:  role "dbm_admin" does not exist', 'missing-role'],
    ['FATAL:  role "smdb" is not permitted to log in', 'refused-login'],
    ['ERROR:  cannot execute ALTER ROLE in a read-only transaction', 'recovery'],
    ['ERROR:  cannot execute ALTER ROLE during recovery', 'recovery'],
    ['ERROR:  something else', 'other'],
  ])('%s', (stderr, cls) => expect(psqlFailureClass(stderr)).toBe(cls));
});

describe('F2: a missing dbm_admin drops the cached role (NM20 3.3: never made again)', () => {
  const MISSING = 'psql: error: connection to server on socket "/var/run/postgresql/.s.PGSQL.5432" failed: FATAL:  role "dbm_admin" does not exist';
  it('a missing-role answer drops the cached role, so the next ensure checks again', async () => {
    dk.answer = () => ({ stdout: 'true\n' });
    await ensureManagerDbRole(t);
    dk.answer = () => ({ err: 'x', stderr: MISSING });
    await readBotLogin(t);
    dk.calls = [];
    await ensureManagerDbRole(t);
    expect(dk.calls.length).toBeGreaterThan(0);
  });
  // NM20 3.3: a container that lost dbm_admin answers the missing role; no CREATE, no login as the bot role. R3.3
  // removed asManager, so no check follows the failed read.
  it('blockBotLogin on a container that lost dbm_admin answers the missing role and sends no ALTER', async () => {
    dk.answer = () => ({ stdout: 'true\n' });
    await ensureManagerDbRole(t);
    dk.answer = (args) => (roleOf({ args }) === 'smdb' ? { stdout: 'CREATE ROLE\n' } : { err: 'x', stderr: MISSING });
    dk.calls = [];
    expect(await blockBotLogin(t)).toMatchObject({ ok: false, cls: 'missing-role' });
    expect(dk.calls.map(c => [roleOf(c), sqlOf(c)])).toEqual([['dbm_admin', READ_SQL]]);
  });
  // NM20 3.3, R3.3: the copy fallback is gone, so a read never runs as the bot role; the row drives readBotLogin.
  it('on a live copy without dbm_admin the login runs once as dbm_admin, never as the bot role, and nothing is logged', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    dk.answer = (args) => roleOf({ args }) === 'smdb'
      ? (args[args.length - 1].startsWith('CREATE') ? { err: 'x', stderr: 'ERROR:  cannot execute CREATE ROLE in a read-only transaction' } : { stdout: 'true|false|0\n' })
      : { err: 'x', stderr: MISSING };
    const r1 = await readBotLogin(t);
    const r2 = await readBotLogin(t);
    expect([r1.ok, r2.ok]).toEqual([false, false]);
    expect(dk.calls.map(c => roleOf(c))).toEqual(['dbm_admin', 'dbm_admin']);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
  it('forgetManagerRole drops the cached role of a removed container', async () => {
    const dbLogin = await import('../../src/instance/dbLogin');
    dk.answer = () => ({ stdout: 'true\n' });
    await ensureManagerDbRole(t);
    dbLogin.forgetManagerRole(t.container);
    dk.calls = [];
    await ensureManagerDbRole(t);
    expect(dk.calls.length).toBe(1);
  });
});
