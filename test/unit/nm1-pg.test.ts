import { spawn, spawnSync, type ChildProcess } from 'child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  MANAGER_DB_ROLE, blockBotLogin, endBotSessions, ensureManagerDbRole, openBotLogin, readBotLogin,
} from '../../src/instance/dbLogin';

const dockerRuns = (() => {
  try {
    return (require('child_process') as typeof import('child_process')).spawnSync('docker', ['version'], { stdio: 'ignore', timeout: 10000 }).status === 0;
  } catch {
    return false;
  }
})();

const NAME = `nm1-pg-${process.pid}`;
const NET = `nm1-pg-net-${process.pid}`;
const USER = 'smdb';
const PASSWORD = 'nm1-test-password';
const t = { container: NAME, user: USER };

const pause = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const run = (args: string[]) => {
  const r = spawnSync('docker', args, { encoding: 'utf-8', timeout: 120000 });
  return { status: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
};
const psql = (container: string, role: string, sql: string, db = 'postgres') =>
  run(['exec', container, 'psql', '-U', role, '-d', db, '-tA', '-v', 'ON_ERROR_STOP=1', '-v', 'VERBOSITY=verbose', '-c', sql]);
const asAdmin = (sql: string, db = 'postgres') => psql(NAME, MANAGER_DB_ROLE, sql, db);
const fromOutside = (role: string, password?: string) =>
  run(['run', '--rm', '--network', NET, ...(password ? ['-e', `PGPASSWORD=${password}`] : []), 'postgres:16-alpine',
    'psql', '-h', NAME, '-U', role, '-d', 'postgres', '-w', '-tA', '-c', 'SELECT 1']);
const waitReady = (container: string) => {
  for (let i = 0; i < 120; i++) {
    // The image's init server listens on the socket only, so a TCP answer means init is over.
    if (run(['exec', container, 'pg_isready', '-h', '127.0.0.1', '-U', USER]).status === 0) return;
    pause(500);
  }
  throw new Error(`${container} did not become ready`);
};
const login = async (target = t) => {
  const r: any = await readBotLogin(target);
  expect(r.ok).toBe(true);
  return r.login as { inRecovery: boolean; canLogin: boolean | null; sessions: number };
};

describe.skipIf(process.platform === 'win32' || !dockerRuns)('NM1 the maintenance login against a real Postgres (Linux with docker)', () => {
  let session: ChildProcess | null = null;

  beforeAll(async () => {
    run(['network', 'create', NET]);
    const started = run(['run', '-d', '--name', NAME, '--network', NET, '-e', `POSTGRES_USER=${USER}`, '-e', `POSTGRES_PASSWORD=${PASSWORD}`,
      'postgres:16-alpine', 'postgres', '-c', 'log_error_verbosity=verbose']);
    expect(started.status, started.err).toBe(0);
    waitReady(NAME);
    const r: any = await ensureManagerDbRole(t);
    expect(r.ok).toBe(true);
  }, 300000);

  afterAll(() => {
    session?.kill();
    run(['rm', '-f', NAME]);
    run(['network', 'rm', NET]);
  }, 120000);

  it('1. a NOLOGIN bootstrap superuser is refused over TCP with its password and over the local socket (28000)', () => {
    expect(asAdmin(`ALTER ROLE "${USER}" NOLOGIN`).status).toBe(0);
    const local = psql(NAME, USER, 'SELECT 1');
    expect(local.status).not.toBe(0);
    expect(local.err).toMatch(/is not permitted to log in/);
    const tcp = fromOutside(USER, PASSWORD);
    expect(tcp.status).not.toBe(0);
    expect(tcp.err).toMatch(/is not permitted to log in/);
    expect(run(['logs', NAME]).err).toMatch(new RegExp(`28000: role "${USER}" is not permitted to log in`));
  }, 120000);

  it('2. dbm_admin logs in over the local socket while the bot role is NOLOGIN and restores its login', () => {
    expect(asAdmin(`SELECT rolsuper::text || rolcanlogin::text FROM pg_roles WHERE rolname = current_user`).out).toBe('truetrue');
    expect(asAdmin(`ALTER ROLE "${USER}" LOGIN`).status).toBe(0);
    expect(asAdmin(`SELECT rolcanlogin::text FROM pg_roles WHERE rolname = '${USER}'`).out).toBe('true');
  }, 120000);

  it('3. dbm_admin cannot log in over TCP from outside the container', () => {
    const r = fromOutside(MANAGER_DB_ROLE);
    expect(r.status).not.toBe(0);
    expect(r.err).toMatch(/password/);
  }, 120000);

  it('4. an open bot session survives NOLOGIN, and endBotSessions ends it', async () => {
    session = spawn('docker', ['exec', NAME, 'psql', '-U', USER, '-d', 'postgres', '-c', 'SELECT pg_sleep(120)'], { stdio: 'ignore' });
    let seen = 0;
    for (let i = 0; i < 40 && seen === 0; i++) {
      seen = (await login()).sessions;
      if (seen === 0) pause(250);
    }
    expect(seen).toBeGreaterThan(0);
    expect(asAdmin(`ALTER ROLE "${USER}" NOLOGIN`).status).toBe(0);
    expect((await login()).sessions).toBeGreaterThan(0);
    const ended: any = await endBotSessions(t);
    expect(ended).toEqual({ ok: true });
    const after = await login();
    expect(after.sessions).toBe(0);
    expect(after.canLogin).toBe(false);
  }, 120000);

  it("5. NOLOGIN survives a container restart and the restore's drop and recreate", async () => {
    expect(run(['restart', NAME]).status).toBe(0);
    waitReady(NAME);
    expect((await login()).canLogin).toBe(false);
    expect(asAdmin(`CREATE DATABASE botdb OWNER "${USER}"`).status).toBe(0);
    expect(asAdmin('DROP DATABASE botdb').status).toBe(0);
    expect(asAdmin(`CREATE DATABASE botdb OWNER "${USER}"`).status).toBe(0);
    expect((await login()).canLogin).toBe(false);
  }, 300000);

  it('6. pg_dump and pg_restore as dbm_admin keep the bot role as owner of the restored objects', () => {
    expect(asAdmin(`SET ROLE "${USER}"; CREATE TABLE kept (x int); INSERT INTO kept VALUES (7);`, 'botdb').status).toBe(0);
    expect(run(['exec', NAME, 'pg_dump', '-U', MANAGER_DB_ROLE, '-d', 'botdb', '-Fc', '-f', '/tmp/nm1.dump']).status).toBe(0);
    expect(asAdmin('DROP DATABASE botdb').status).toBe(0);
    expect(asAdmin(`CREATE DATABASE botdb OWNER "${USER}"`).status).toBe(0);
    const restored = run(['exec', NAME, 'pg_restore', '-U', MANAGER_DB_ROLE, '-d', 'botdb', '/tmp/nm1.dump']);
    expect(restored.status, restored.err).toBe(0);
    expect(asAdmin(`SELECT tableowner || ':' || (SELECT x FROM kept)::text FROM pg_tables WHERE tablename = 'kept'`, 'botdb').out).toBe(`${USER}:7`);
  }, 120000);

  it('7. pg_isready -U <bot role> exits 0 while the role is NOLOGIN', async () => {
    expect((await login()).canLogin).toBe(false);
    expect(run(['exec', NAME, 'pg_isready', '-U', USER]).status).toBe(0);
  }, 120000);

  it('8. blockBotLogin, endBotSessions, readBotLogin, openBotLogin and ensureManagerDbRole against the container', async () => {
    expect(((await openBotLogin(t)) as any).ok).toBe(true);
    const open = await login();
    expect(open).toMatchObject({ inRecovery: false, canLogin: true });
    expect(psql(NAME, USER, 'SELECT 1').status).toBe(0);
    expect(((await blockBotLogin(t)) as any).ok).toBe(true);
    expect((await login()).canLogin).toBe(false);
    expect(psql(NAME, USER, 'SELECT 1').err).toMatch(/is not permitted to log in/);
    expect(await endBotSessions(t)).toEqual({ ok: true });
    expect((await login()).sessions).toBe(0);
    expect(((await ensureManagerDbRole(t)) as any).ok).toBe(true);
    const missing: any = await readBotLogin({ container: NAME, user: 'nobody_here' });
    expect(missing.ok ? missing.login.canLogin : null).toBeNull();
  }, 120000);

  // Row 9 runs only when SMDB_PG_STANDBY names a hot standby of the main in SMDB_PG_MAIN (both built by the main session).
  it.skipIf(!process.env.SMDB_PG_STANDBY || !process.env.SMDB_PG_MAIN)('9. a hot standby refuses ALTER ROLE (25006), reads in recovery, and follows the NOLOGIN set on the main', async () => {
    const standby = { container: process.env.SMDB_PG_STANDBY as string, user: USER };
    const refused = psql(standby.container, MANAGER_DB_ROLE, `ALTER ROLE "${USER}" LOGIN`);
    expect(refused.status).not.toBe(0);
    expect(refused.err).toMatch(/25006/);
    expect(((await blockBotLogin(standby)) as any).ok).toBe(false);
    expect(((await openBotLogin(standby)) as any).ok).toBe(false);
    const main = { container: process.env.SMDB_PG_MAIN as string, user: USER };
    expect(((await blockBotLogin(main)) as any).ok).toBe(true);
    let copy = await login(standby);
    for (let i = 0; i < 40 && copy.canLogin !== false; i++) {
      pause(250);
      copy = await login(standby);
    }
    expect(copy.inRecovery).toBe(true);
    expect(copy.canLogin).toBe(false);
  }, 120000);
});
