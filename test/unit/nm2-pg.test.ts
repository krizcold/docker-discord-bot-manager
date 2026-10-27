import { spawn, spawnSync, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { COUNTS_SQL, backupDir, errorLine, holderStdin, isRecoveryConflict, parseCountLines, parseDfFreeKb, compareCounts } from '../../src/instance/backupFiles';

const dockerRuns = (() => {
  try {
    return (require('child_process') as typeof import('child_process')).spawnSync('docker', ['version'], { stdio: 'ignore', timeout: 10000 }).status === 0;
  } catch {
    return false;
  }
})();

const NAME = `nm2-pg-${process.pid}`;
const THROWAWAY = `nm2-pg-throwaway-${process.pid}`;
// The entry-point rows' bot ids; the test restore's throwaway is smdb-testrestore-<id>, so the pid keeps it unique.
const BOT = `nm2pg${process.pid}`;
const STANDBY_BOT = `nm2pgs${process.pid}`;
const USER = 'app';
const DB = 'app';

const pause = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const run = (args: string[], input?: string) => {
  const r = spawnSync('docker', args, { encoding: 'utf-8', timeout: 300000, input });
  return { status: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
};
const psql = (container: string, sql: string, db = DB, user = USER) => run(['exec', container, 'psql', '-X', '-U', user, '-d', db, '-tA', '-v', 'ON_ERROR_STOP=1', '-c', sql]);
const waitTcp = (container: string) => {
  for (let i = 0; i < 180; i++) {
    if (run(['exec', container, 'pg_isready', '-h', '127.0.0.1', '-q']).status === 0) return;
    pause(500);
  }
  throw new Error(`${container} did not become ready`);
};

/** A holder as the dump runs it: answers the snapshot line and the counts once `end|` is printed; the session stays open until end() is called. */
function openHolder(container: string, user = USER, db = DB): Promise<{ child: ChildProcess; snap: string[]; counts: Record<string, number>; stderr: () => string; end: () => void }> {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', ['exec', '-i', container, 'psql', '-X', '-q', '-tA', '-v', 'ON_ERROR_STOP=1', '-U', user, '-d', db]);
    let out = '';
    let err = '';
    child.stdout!.on('data', d => {
      out += d.toString();
      if (!out.includes('\nend|') && !out.startsWith('end|')) return;
      const lines = out.split('\n');
      const snap = lines.find(l => l.startsWith('snap|'))!.split('|');
      const parsed = parseCountLines(out);
      if (!parsed.ok) return reject(new Error(parsed.error));
      resolve({ child, snap, counts: parsed.counts, stderr: () => err, end: () => { child.stdin!.write('COMMIT;\n'); child.stdin!.end(); } });
    });
    child.stderr!.on('data', d => { err += d.toString(); });
    child.on('close', code => reject(new Error(`holder exited ${code}: ${err}`)));
    child.stdin!.write(holderStdin(720));
  });
}

const countsOf = (container: string, db: string, user = USER) => {
  const r = psql(container, COUNTS_SQL, db, user);
  expect(r.status, r.err).toBe(0);
  const parsed = parseCountLines(r.out + '\n');
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.counts;
};

describe.skipIf(process.platform === 'win32' || !dockerRuns)('NM2 the dump snapshot and the test restore against a real Postgres (Linux with docker)', () => {
  let fleet: typeof import('../../src/instance/fleetBackup');
  let check: typeof import('../../src/instance/backupCheck');
  let dbLogin: typeof import('../../src/instance/dbLogin');
  let dataDir = '';
  const instance = (id: string, containerName: string, user: string, db: string): any => ({
    id, displayName: `NM2 ${id}`, sanitizedName: id, sourceUrl: 'x', status: 'running', createdAt: new Date().toISOString(),
    fleetDb: { containerName, user, db, volume: `${containerName}-data`, password: 'pw', image: 'postgres:16-alpine' },
  });

  beforeAll(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nm2-pg-'));
    process.env.DATA_DIR = dataDir;
    fleet = await import('../../src/instance/fleetBackup');
    check = await import('../../src/instance/backupCheck');
    dbLogin = await import('../../src/instance/dbLogin');
  });

  beforeAll(() => {
    const started = run(['run', '-d', '--name', NAME, '-e', `POSTGRES_USER=${USER}`, '-e', 'POSTGRES_PASSWORD=pw', '-e', `POSTGRES_DB=${DB}`, 'postgres:16-alpine']);
    expect(started.status, started.err).toBe(0);
    waitTcp(NAME);
    expect(psql(NAME, 'CREATE SCHEMA smdb_data; CREATE TABLE smdb_data."guild|list" (id int); INSERT INTO smdb_data."guild|list" SELECT generate_series(1, 50); CREATE TABLE public.t (x int); INSERT INTO public.t VALUES (1), (2); CREATE UNLOGGED TABLE public.scratch (x int); INSERT INTO public.scratch VALUES (9);').status).toBe(0);
  }, 300000);

  afterAll(() => {
    run(['rm', '-f', '-v', NAME]);
    run(['rm', '-f', '-v', THROWAWAY]);
    run(['volume', 'rm', THROWAWAY]);
    run(['rm', '-f', '-v', `smdb-testrestore-${BOT}`]);
    run(['volume', 'rm', `smdb-testrestore-${BOT}`]);
    if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
  }, 120000);

  it('R1 pg_export_snapshot plus pg_dump --snapshot: the counts equal a later restore, not the rows written after the snapshot', async () => {
    const holder = await openHolder(NAME);
    expect(holder.snap[2]).toBe('f');
    expect(psql(NAME, 'INSERT INTO public.t VALUES (3), (4), (5)').status).toBe(0);
    const dump = run(['exec', NAME, 'pg_dump', '-U', USER, '-Fc', `--snapshot=${holder.snap[1]}`, '-f', '/tmp/r1.dump', DB]);
    holder.end();
    expect(dump.status, dump.err).toBe(0);
    expect(holder.counts['public.t']).toBe(2);
    expect(holder.counts['smdb_data."guild|list"']).toBe(50);
    expect(holder.counts['public.scratch']).toBeUndefined();
    expect(psql(NAME, 'CREATE DATABASE r1', 'postgres').status).toBe(0);
    const restored = run(['exec', NAME, 'pg_restore', '-U', USER, '--no-owner', '--no-privileges', '--exit-on-error', '-d', 'r1', '/tmp/r1.dump']);
    expect(restored.status, restored.err).toBe(0);
    expect(compareCounts(holder.counts, countsOf(NAME, 'r1')).ok).toBe(true);
  }, 300000);

  // R2 and R3 run only when SMDB_PG_STANDBY names a hot standby of the main in SMDB_PG_MAIN (built by the main session,
  // the standby with max_standby_streaming_delay = 1s), whose bootstrap role is SMDB_PG_USER and database SMDB_PG_DB.
  const standby = process.env.SMDB_PG_STANDBY;
  const main = process.env.SMDB_PG_MAIN;
  const sUser = process.env.SMDB_PG_USER || 'smdb';
  const sDb = process.env.SMDB_PG_DB || 'smdb';

  it.skipIf(!standby || !main)('R2 a dump on a standby in recovery: inRecovery t, unlogged data skipped, and COUNTS_SQL leaves unlogged tables out', async () => {
    expect(psql(main!, 'DROP TABLE IF EXISTS nm2_logged, nm2_unlogged; CREATE TABLE nm2_logged (x int); INSERT INTO nm2_logged SELECT generate_series(1, 7); CREATE UNLOGGED TABLE nm2_unlogged (x int); INSERT INTO nm2_unlogged VALUES (1);', sDb, sUser).status).toBe(0);
    pause(2000);
    const holder = await openHolder(standby!, sUser, sDb);
    expect(holder.snap[2]).toBe('t');
    expect(Number(holder.snap[4])).toBeGreaterThan(0);
    const dump = run(['exec', standby!, 'pg_dump', '-U', sUser, '-Fc', `--snapshot=${holder.snap[1]}`, '-f', '/tmp/r2.dump', sDb]);
    holder.end();
    expect(dump.status, dump.err).toBe(0);
    expect(holder.counts['public.nm2_logged']).toBe(7);
    expect(holder.counts['public.nm2_unlogged']).toBeUndefined();
    run(['cp', `${standby}:/tmp/r2.dump`, '/tmp/nm2-r2.dump']);
    run(['cp', '/tmp/nm2-r2.dump', `${NAME}:/tmp/r2.dump`]);
    expect(psql(NAME, 'CREATE DATABASE r2', 'postgres').status).toBe(0);
    const restored = run(['exec', NAME, 'pg_restore', '-U', USER, '--no-owner', '--no-privileges', '--exit-on-error', '-d', 'r2', '/tmp/r2.dump']);
    expect(restored.status, restored.err).toBe(0);
    expect(psql(NAME, 'SELECT count(*) FROM nm2_unlogged', 'r2').out).toBe('0');
    expect(compareCounts(holder.counts, countsOf(NAME, 'r2')).ok).toBe(true);
  }, 300000);

  it.skipIf(!standby || !main)('R3 a forced replay conflict on the standby answers "conflict with recovery"', async () => {
    expect(psql(main!, 'DROP TABLE IF EXISTS nm2_conflict; CREATE TABLE nm2_conflict (x int); INSERT INTO nm2_conflict SELECT generate_series(1, 1000);', sDb, sUser).status).toBe(0);
    pause(2000);
    const holder = await openHolder(standby!, sUser, sDb);
    expect(psql(main!, 'DELETE FROM nm2_conflict;', sDb, sUser).status).toBe(0);
    expect(psql(main!, 'VACUUM nm2_conflict;', sDb, sUser).status).toBe(0);
    pause(4000);
    const closed = new Promise<void>(resolve => holder.child.on('close', () => resolve()));
    holder.child.stdin!.write('SELECT count(*) FROM nm2_conflict;\n');
    holder.child.stdin!.end();
    await closed;
    expect(holder.stderr()).toMatch(/conflict with recovery/i);
    expect(isRecoveryConflict(holder.stderr())).toBe(true);
    expect(errorLine(holder.stderr())).toMatch(/\b(ERROR|FATAL):.*conflict with recovery/);
  }, 300000);

  it.skipIf(!standby || !main)('R9 runFleetDump on the hot standby: the dump and its counts file, taken in recovery as dbm_admin', async () => {
    expect((await dbLogin.ensureManagerDbRole({ container: main!, user: sUser })).ok).toBe(true);
    for (let i = 0; i < 40 && psql(standby!, "SELECT count(*) FROM pg_roles WHERE rolname = 'dbm_admin'", sDb, sUser).out !== '1'; i++) pause(250);
    const r = await fleet.runFleetDump(instance(STANDBY_BOT, standby!, sUser, sDb), 'pre-nm2-');
    expect(r.success, r.error).toBe(true);
    const dir = backupDir(STANDBY_BOT);
    expect(fs.existsSync(path.join(dir, r.file!))).toBe(true);
    const meta = JSON.parse(fs.readFileSync(path.join(dir, `${r.file}.json`), 'utf-8'));
    expect(meta.inRecovery).toBe(true);
    expect(meta.counts['public.nm2_logged']).toBe(7);
  }, 300000);

  it.skipIf(!standby || !main)('R10 runFleetDump on the standby after dbm_admin is dropped on the main and the drop replayed: the bot-role fallback dumps', async () => {
    expect(psql(main!, 'DROP ROLE IF EXISTS dbm_admin', sDb, sUser).status).toBe(0);
    let left = '1';
    for (let i = 0; i < 40 && left !== '0'; i++) {
      pause(250);
      left = psql(standby!, "SELECT count(*) FROM pg_roles WHERE rolname = 'dbm_admin'", sDb, sUser).out;
    }
    expect(left).toBe('0');
    const warned: string[] = [];
    const spy = vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => { warned.push(a.map(String).join(' ')); });
    try {
      const r = await fleet.runFleetDump(instance(`${STANDBY_BOT}f`, standby!, sUser, sDb), 'pre-nm2-');
      expect(r.success, r.error).toBe(true);
      expect(fs.existsSync(path.join(backupDir(`${STANDBY_BOT}f`), `${r.file}.json`))).toBe(true);
    } finally {
      spy.mockRestore();
      dbLogin.forgetManagerRole(main!);
      await dbLogin.ensureManagerDbRole({ container: main!, user: sUser });
    }
    expect(warned.join('\n')).toContain(`the role dbm_admin has not reached this live copy from its main yet, so the manager logs in as ${sUser}`);
  }, 300000);

  it('R4 the throwaway: TCP readiness waits for the final server, and a dump restores with --no-owner --no-privileges with matching counts', async () => {
    run(['volume', 'create', '--label', 'smdb.testrestore=nm2', THROWAWAY]);
    const started = run(['run', '-d', '--name', THROWAWAY, '--label', 'smdb.testrestore=nm2', '--network', 'none', '--memory', '1g', '--cpus', '1',
      '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', '-e', 'POSTGRES_DB=restorecheck', '-e', 'POSTGRES_INITDB_ARGS=--data-checksums',
      '-v', `${THROWAWAY}:/var/lib/postgresql/data`, 'postgres:16-alpine']);
    expect(started.status, started.err).toBe(0);
    waitTcp(THROWAWAY);
    expect(run(['logs', THROWAWAY]).out + run(['logs', THROWAWAY]).err).toMatch(/PostgreSQL init process complete/);
    const dump = run(['exec', NAME, 'pg_dump', '-U', USER, '-Fc', '-f', '/tmp/r4.dump', DB]);
    expect(dump.status, dump.err).toBe(0);
    const bytes = spawnSync('docker', ['exec', NAME, 'cat', '/tmp/r4.dump']).stdout;
    const restored = spawnSync('docker', ['exec', '-i', THROWAWAY, 'timeout', '-s', 'KILL', '600', 'pg_restore', '-U', 'postgres', '--no-owner', '--no-privileges', '--exit-on-error', '-d', 'restorecheck'], { input: bytes, encoding: 'utf-8' });
    expect(restored.status, restored.stderr).toBe(0);
    expect(compareCounts(countsOf(NAME, DB), countsOf(THROWAWAY, 'restorecheck', 'postgres')).ok).toBe(true);
  }, 300000);

  it("R5 killing the holder's docker exec client ends its session within 10 s", async () => {
    const holder = await openHolder(NAME);
    const open = () => Number(psql(NAME, "SELECT count(*) FROM pg_stat_activity WHERE state = 'idle in transaction'").out);
    expect(open()).toBeGreaterThan(0);
    holder.child.kill('SIGKILL');
    let left = open();
    for (let i = 0; i < 40 && left > 0; i++) { pause(250); left = open(); }
    expect(left).toBe(0);
  }, 120000);

  let r7File = '';

  it('R7 a dump through runFleetDump as dbm_admin: the .dump and .dump.json exist, and the counts equal a restore of the dump', async () => {
    expect((await dbLogin.ensureManagerDbRole({ container: NAME, user: USER })).ok).toBe(true);
    fs.writeFileSync(path.join(dataDir, 'instances.json'), JSON.stringify({ instances: { [BOT]: instance(BOT, NAME, USER, DB) } }));
    const r = await fleet.runFleetDump(instance(BOT, NAME, USER, DB), 'pre-nm2-');
    expect(r.success, r.error).toBe(true);
    r7File = r.file!;
    const dir = backupDir(BOT);
    expect(fs.existsSync(path.join(dir, r7File))).toBe(true);
    const meta = JSON.parse(fs.readFileSync(path.join(dir, `${r7File}.json`), 'utf-8'));
    expect(meta).toMatchObject({ file: r7File, family: 'main', kind: 'safety', inRecovery: false });
    expect(run(['cp', path.join(dir, r7File), `${NAME}:/tmp/r7.dump`]).status).toBe(0);
    expect(psql(NAME, 'CREATE DATABASE r7', 'postgres').status).toBe(0);
    const restored = run(['exec', NAME, 'pg_restore', '-U', USER, '--no-owner', '--no-privileges', '--exit-on-error', '-d', 'r7', '/tmp/r7.dump']);
    expect(restored.status, restored.err).toBe(0);
    expect(compareCounts(meta.counts, countsOf(NAME, 'r7')).ok).toBe(true);
  }, 300000);

  it('R8 runTestRestore on that dump passes, and its throwaway is gone after', async () => {
    expect(r7File).not.toBe('');
    const bot = instance(BOT, NAME, USER, DB);
    const rec = await check.runTestRestore(bot, 'main', r7File);
    expect(rec?.result, rec?.text).toBe('passed');
    expect(run(['inspect', `smdb-testrestore-${BOT}`]).status).not.toBe(0);
    expect(run(['volume', 'inspect', `smdb-testrestore-${BOT}`]).status).not.toBe(0);
  }, 600000);

  it('R6 df -Pk in postgres:16-alpine parses to the free KB', () => {
    const df = run(['exec', NAME, 'df', '-Pk', '/var/lib/postgresql/data']);
    expect(df.status, df.err).toBe(0);
    const free = parseDfFreeKb(df.out);
    expect(free).not.toBeNull();
    expect(free!).toBeGreaterThan(0);
  }, 60000);
});
