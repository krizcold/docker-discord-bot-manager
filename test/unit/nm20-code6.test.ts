import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// NM20 part 6: Receive's two logins, the push of R3.6 with X1's meta transaction, the last step and the receiver's
// end (Y3, Z1, Q1). The docker client containers answer through switch-fake's run handler; the sender's two
// pg_restore reads (the meta read and the table of contents) answer with the text pg_restore 16 prints.

const tmp = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm20-code6-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return { dir, join: null as unknown, joinCalls: [] as unknown[][] };
});

const g = vi.hoisted(() => ({ meta: '', toc: '', restoreReads: [] as string[][], faults: [] as string[] }));

vi.mock('child_process', async (o) => {
  const real = await o<typeof import('child_process')>();
  const m = (await import('./switch-harness')).childProcessMock(real) as Record<string, any>;
  const { EventEmitter } = await import('events');
  const { PassThrough } = await import('stream');
  const spawn = (cmd: string, args: string[], opts?: unknown) => {
    if (cmd === 'docker' && args[0] === 'exec' && args.includes('pg_restore')) {
      g.restoreReads.push(args);
      const text = args.includes('-l') ? (args.includes('-n') ? MANAGER_TOC : g.toc) : g.meta;
      const c: any = new EventEmitter();
      c.stdout = new PassThrough();
      c.stderr = new PassThrough();
      c.stdin = new PassThrough();
      c.kill = () => true;
      c.stdin.on('data', () => undefined);
      c.stdin.on('finish', () => setTimeout(() => { c.stdout.end(text); c.stderr.end(''); setTimeout(() => c.emit('close', 0), 1); }, 1));
      return c;
    }
    return m.spawn(cmd, args, opts);
  };
  return { ...m, spawn, default: { ...m.default, spawn } };
});
vi.mock('../../src/instance/dbLogin', async (o) => {
  const m = (await import('./switch-harness')).dbLoginMock(await o()) as Record<string, any>;
  const inner = m.noteLoginFault;
  return { ...m, noteLoginFault: (c: string) => { g.faults.push(c); return inner(c); } };
});
vi.mock('../../src/instance/maintenance', async (o) => (await import('./switch-harness')).maintenanceMock(await o()));
vi.mock('../../src/docker/containerManager', async (o) => (await import('./switch-harness')).containerManagerMock(await o()));
vi.mock('../../src/instance/fleetBackup', async (o) => (await import('./switch-harness')).fleetBackupMock(await o()));
vi.mock('../../src/instance/fleetJoin', async (o) => (await import('./switch-harness')).fleetJoinMock(await o()));
vi.mock('../../src/instance/fleetReplica', async (o) => (await import('./switch-harness')).fleetReplicaMock(await o()));
vi.mock('../../src/instance/appHookClient', async (o) => (await import('./switch-harness')).appHookMock(await o()));
vi.mock('../../src/instance/backupCheck', async (o) => (await import('./switch-harness')).backupCheckMock(await o()));
vi.mock('../../src/env/manager', async (o) => (await import('./switch-harness')).envMock(await o()));
vi.mock('../../src/config/appCapabilities', async (o) => (await import('./switch-harness')).capsMock(await o()));
vi.mock('../../src/instance/fleetReplication', async (o) => ({
  ...(await o<typeof import('../../src/instance/fleetReplication')>()),
  getJoinCode: async (...a: unknown[]) => { tmp.joinCalls.push(a); return tmp.join; },
}));

import * as fs from 'fs';
import * as path from 'path';
import { decodeMoveCode, encodeJoinCode, encodeMoveCode } from '../../src/config/joinCode';
import { MOVE_TIMING, push, receive, receiveStep, stopReceive } from '../../src/instance/fleetMove';
import { MANAGER_SESSION_OPTIONS } from '../../src/instance/dbLogin';
import { parseMetaRows, SHARD_CAP_DO_SQL } from '../../src/instance/switchSql';
import { validAddress } from '../../src/instance/fleetJoin';
import { restoreLists } from '../../src/instance/fleetBackup';
import { releaseFleetBackupBusy } from '../../src/instance/fleetBackupGuards';
import * as containerManager from '../../src/docker/containerManager';
import { fake, FIXTURE_PEM, fakeJoin, freshDb, h, mainFixture, resetHarness, stored, writeRegistry } from './switch-harness';

const FILE = 'pre-push-2026-10-28T12-00-00-000Z.dump';
const SUM = 'checksum|"public"."t"|0123456789abcdef0123456789abcdef';
const PUSH_ID = '0123456789abcdef01234567';
const CODE = encodeMoveCode({ ...fakeJoin({ host: 'win.example', port: 5440, machine: 'win.example', db: 'app', app: { user: 'app', password: 'apppw' } }), recv: { user: 'smdb_receive', password: 'recvpw', id: PUSH_ID }, recvMeta: { user: 'smdb_receive_meta', password: 'metapw' } } as any);
const DIR = path.join(tmp.dir, 'backups', 'a', 'fleet-postgres');
const PINS = `PGOPTIONS=${MANAGER_SESSION_OPTIONS}`;
const PINS_EXEMPT = `PGOPTIONS=${MANAGER_SESSION_OPTIONS} -c default_transaction_read_only=off`;
const RECVLOGIN = "The push to win.example stopped: win.example refused the move code's login after the data was sent (code in the pushed database may have changed its password, or the code expired, or receiving was stopped or restarted there). win.example's database is incomplete, and its bot stays Off. On win.example, press Receive for a new move code and push with it, or Cancel the push.";
const REFUSED = (login: string) => `psql: error: connection to server at "win.example" (10.0.0.9), port 5440 failed: FATAL:  password authentication failed for user "${login}"`;

// The meta text in pg_restore 16's form (linux-pg-part2.txt): the entry headers, then each table's COPY block.
const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/\t/g, '\\t').replace(/\n/g, '\\n').replace(/\r/g, '\\r');
const TS = '2026-11-13 11:32:24.119536+00';
const entry = (table: string, cols: string, rows: string[]) => `--\n-- Data for Name: ${table}; Type: TABLE DATA; Schema: smdb_manager; Owner: dbm_meta\n--\n\nCOPY smdb_manager.${table} (${cols}) FROM stdin;\n${rows.map(r => `${r}\n`).join('')}\\.\n\n\n`;
const metaDump = (...entries: string[]) => `--\n-- PostgreSQL database dump\n--\n\nSET statement_timeout = 0;\nSET row_security = off;\n\n${entries.join('')}--\n-- PostgreSQL database dump complete\n--\n\n`;
const addressRow = (host: string, port: number | string, cert = esc(FIXTURE_PEM.trim()), at = TS) => `${host}\t${port}\t\\N\t${cert}\tmain.example\t${at}`;
const ADDR_COLS = 'host, port, slot, cert, machine, updated_at';
const GENERATION = entry('generation', 'one_row, machine, generation, since', [`t\tmain.example\t3\t${TS}`]);
const RECEIVED = entry('received', 'push_id, from_system_id, from_machine, generation, at', [`fedcba9876543210fedcba98\t7349081263451237\tother.example\t2\t${TS}`]);
const META = metaDump(entry('addresses', ADDR_COLS, [addressRow('main.example', 5433)]), GENERATION, RECEIVED);
const TOC = [
  ';',
  '; Archive created at 2026-11-13 11:32:24 UTC',
  ';',
  '5; 2615 16398 SCHEMA - smdb_data app',
  '6; 2615 16399 SCHEMA - smdb_manager dbm_meta',
  '3401; 0 0 COMMENT - SCHEMA smdb_manager dbm_meta',
  '218; 1259 16401 TABLE smdb_data guild_ownership app',
  '220; 1259 16410 TABLE smdb_manager generation dbm_meta',
  '3390; 0 16401 TABLE DATA smdb_data guild_ownership app',
  '3392; 0 16410 TABLE DATA smdb_manager generation dbm_meta',
  '3403; 0 0 ACL - SCHEMA smdb_manager dbm_meta',
  '',
].join('\n');
/** pg_restore -l -n smdb_manager of the same dump: the schema's own entries are not listed. */
const MANAGER_TOC = [
  ';',
  '; Archive created at 2026-11-13 11:32:24 UTC',
  ';',
  '220; 1259 16410 TABLE smdb_manager generation dbm_meta',
  '3392; 0 16410 TABLE DATA smdb_manager generation dbm_meta',
  '',
].join('\n');

type Answer = { code: number; stdout: string; stderr: string };
let answers: Record<string, Answer> = {};
type Run = { step: string; args: string[]; env: Record<string, string | undefined>; input: string; list: string | null };
const runs: Run[] = [];
const ok = (stdout = ''): Answer => ({ code: 0, stdout, stderr: '' });
const bad = (stderr: string): Answer => ({ code: 1, stdout: '', stderr });
const run = (step: string) => runs.find(r => r.step === step)!;
const userOf = (r: Run) => /^postgresql:\/\/([^@]+)@/.exec(r.args.find(a => a.startsWith('postgresql://'))!)![1];
const execs = (mark: string) => fake.calls.filter(c => c.args[0] === 'exec' && c.input.includes(mark));
const loginOf = (args: string[]) => `${args[args.indexOf('-U') + 1]} ${args[args.indexOf('-d') + 1]}`;
const scriptOf = (r: Run) => r.args[r.args.indexOf('postgres:16-alpine') + 2];

const OFF = { state: 'off', message: '', orderedAt: '2026-10-30T00:00:00.000Z', settled: true, hook: 'confirmed', login: 'blocked', savedByBot: 'maintenance' };

beforeEach(() => {
  resetHarness();
  releaseFleetBackupBusy('a');
  fake.dbs['a-pg'] = freshDb();
  writeRegistry({ a: mainFixture() });
  MOVE_TIMING.sessionPauseMs = 0;
  runs.length = 0;
  g.meta = META;
  g.toc = TOC;
  g.restoreReads.length = 0;
  g.faults.length = 0;
  tmp.joinCalls.length = 0;
  tmp.join = { success: true, joinCode: encodeJoinCode(fakeJoin({ host: 'main.example', port: 5433 })) };
  answers = { probe: ok('false\n2|win.example|\n0\n'), counts: ok('count|"public"."t"|3\n'), sums: ok(`${SUM}\n`) };
  fake.run = (args, env, input) => {
    const name = args[args.indexOf('--name') + 1];
    const step = name.split('-fleet-move-')[1];
    const v = args.indexOf('-v', args.indexOf('-v') + 1);
    const listFile = v > 0 ? args[v + 1].replace(/:\/tmp\/smdb-restore\.list:ro$/, '') : null;
    let list: string | null = null;
    try { list = listFile ? fs.readFileSync(path.join(tmp.dir, 'bots', 'a', 'fleet-join', path.basename(listFile)), 'utf-8') : null; } catch { list = null; }
    runs.push({ step, args, env, input, list });
    h.events.push(`client:${step}`);
    return answers[step] ?? ok();
  };
  fs.rmSync(DIR, { recursive: true, force: true });
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(path.join(DIR, FILE), 'PGDMP');
  fs.writeFileSync(path.join(DIR, `${FILE}.json`), JSON.stringify({ file: FILE, takenAt: 1, family: 'main', kind: 'safety', inRecovery: false, dataAt: null, dbBytes: 1, counts: { '"public"."t"': 3 }, tables: 1, rows: 3 }));
});
afterEach(() => vi.restoreAllMocks());
afterAll(() => fs.rmSync(tmp.dir, { recursive: true, force: true }));

describe('NM20 part 6: Receive makes both logins (R3.6, P1, S5)', () => {
  it('P1: one cluster script as dbm_admin on postgres makes both plain logins, and the move code carries both passwords', async () => {
    writeRegistry({ a: mainFixture({ maintenance: OFF }) });
    h.proof = { ok: true, state: 'off', enforcement: 'database', botConfirmed: true };
    const r = await receive('a');
    expect(r.success).toBe(true);
    const [role] = execs('CREATE ROLE smdb_receive_meta');
    expect(loginOf(role.args)).toBe('dbm_admin postgres');
    const sql = role.input;
    expect(sql).not.toMatch(/(^|[^O])SUPERUSER/);
    expect(sql).toContain('CREATE ROLE smdb_receive LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD ');
    expect(sql).toContain('CREATE ROLE smdb_receive_meta LOGIN NOSUPERUSER CREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD ');
    expect(sql).toContain('GRANT dbm_work TO smdb_receive;');
    expect(sql).toContain('GRANT dbm_meta, "app", pg_signal_backend TO smdb_receive_meta;');
    expect(sql).toContain('ALTER ROLE smdb_receive SET search_path = pg_catalog, pg_temp;');
    expect(sql).toContain('ALTER ROLE smdb_receive_meta SET search_path = pg_catalog, pg_temp;');
    const decoded = decodeMoveCode(r.moveCode!);
    if (!decoded.ok) throw new Error(decoded.why);
    const { recv, recvMeta } = decoded.code;
    expect(recvMeta.user).toBe('smdb_receive_meta');
    expect(recv.password).not.toBe(recvMeta.password);
    const expiry = stored('a').fleetDb.receive.expiresAt;
    expect(sql).toContain(`CREATE ROLE smdb_receive LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${recv.password}' VALID UNTIL '${expiry}'`);
    expect(sql).toContain(`CREATE ROLE smdb_receive_meta LOGIN NOSUPERUSER CREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${recvMeta.password}' VALID UNTIL '${expiry}'`);
    expect(role.args.join(' ')).not.toContain(recv.password);
    expect(role.args.join(' ')).not.toContain(recvMeta.password);
  });
  it('S1, U4: the receive mark write (mv:238) and its clear (mv:152) run as dbm_admin on postgres', async () => {
    writeRegistry({ a: mainFixture({ maintenance: OFF }) });
    h.proof = { ok: true, state: 'off', enforcement: 'database', botConfirmed: true };
    expect((await receive('a')).success).toBe(true);
    expect(await stopReceive('a')).toMatchObject({ success: true });
    const write = execs('INSERT INTO smdb_manager.receive_mark');
    const clear = execs('DELETE FROM smdb_manager.receive_mark');
    expect(write.length).toBe(1);
    expect(clear.length).toBe(1);
    for (const c of [...write, ...clear]) expect(loginOf(c.args)).toBe('dbm_admin postgres');
  });
});

describe('NM20 part 6: the push (R3.6, X1, Y1, Y6, Z5, U2, U7)', () => {
  it('P2: a move code without the second login is refused at decode, and nothing is sent', async () => {
    const plain = `smdbmove1.${Buffer.from(JSON.stringify({ ...fakeJoin({ host: 'win.example', port: 5440, machine: 'win.example', db: 'app', app: { user: 'app', password: 'apppw' } }), recv: { user: 'smdb_receive', password: 'recvpw', id: PUSH_ID } })).toString('base64url')}`;
    const r = await push('a', plain);
    expect(r.text).toBe('This move code was made before the receive logins had a second login; make a new one with Receive.');
    expect(runs).toEqual([]);
  });
  it('P3, W6, W8: every receiver step runs as its login with the pins, in order, and no password reaches an argv', async () => {
    const r = await push('a', CODE);
    expect(r.success).toBe(true);
    expect(runs.map(x => x.step)).toEqual(['probe', 'create', 'meta', 'push', 'counts', 'sums', 'cap', 'commit', 'last', 'last-meta']);
    const meta = ['probe', 'create', 'meta', 'commit', 'last-meta'];
    for (const x of runs) {
      const login = meta.includes(x.step) ? 'smdb_receive_meta' : 'smdb_receive';
      expect([x.step, userOf(x), x.env.PGPASSWORD]).toEqual([x.step, login, login === 'smdb_receive' ? 'recvpw' : 'metapw']);
      expect(x.args).toContain(PINS);
      expect(x.args.join(' ')).not.toMatch(/recvpw|metapw/);
    }
    const create = scriptOf(run('create'));
    expect(create).toContain('DROP DATABASE IF EXISTS "app" WITH (FORCE)');
    expect(create).toContain('CREATE DATABASE "app" OWNER "app"');
    expect(create).toContain('GRANT CONNECT, CREATE ON DATABASE "app" TO dbm_meta');
    expect(create).toContain('GRANT CONNECT ON DATABASE "app" TO dbm_work');
    expect(run('create').args.find(a => a.startsWith('postgresql://'))).toContain('/postgres?');
  });
  it('W8: this machine\'s checksums run as dbm_work with the pins; its identity read as dbm_admin on postgres', async () => {
    expect((await push('a', CODE)).success).toBe(true);
    const [sums] = execs("SELECT 'checksum|'");
    expect(loginOf(sums.args)).toBe('dbm_work app');
    expect(sums.args).toContain(PINS);
    const [sys] = execs('pg_control_system()');
    expect(loginOf(sys.args)).toBe('dbm_admin postgres');
  });
  it('Z5, Y6, S3: the meta transaction goes through docker run -i on stdin, opens with SET ROLE dbm_meta and carries its own BEGIN and COMMIT', async () => {
    const rows = Array.from({ length: 1000 }, (_v, i) => addressRow(`host${i}.example`, 5000 + i));
    g.meta = metaDump(entry('addresses', ADDR_COLS, rows), GENERATION);
    expect((await push('a', CODE)).success).toBe(true);
    const m = run('meta');
    expect(m.args).toContain('-i');
    expect(m.input.startsWith('SET ROLE dbm_meta;\nBEGIN;\n')).toBe(true);
    expect(m.input.endsWith('COMMIT;\n')).toBe(true);
    expect(m.input).toContain('CREATE SCHEMA smdb_manager;');
    expect(m.input).toContain('GRANT SELECT ON ALL TABLES IN SCHEMA smdb_manager TO dbm_work;');
    expect(m.input.match(/INSERT INTO smdb_manager\.addresses /g)).toHaveLength(1000);
    expect(scriptOf(m)).not.toMatch(/--single-transaction|(^| )-1( |$)/);
    for (const x of runs) for (const a of x.args) expect(a.length).toBeLessThanOrEqual(4096);
  });
  it('S2: pg_restore runs as smdb_receive with only the other list mounted, and the list file is gone after the push', async () => {
    expect((await push('a', CODE)).success).toBe(true);
    const p = run('push');
    expect(scriptOf(p)).toMatch(/pg_restore .*--role="\$2" --no-owner --no-privileges --single-transaction --exit-on-error -L \/tmp\/smdb-restore\.list/);
    expect(p.args[p.args.length - 1]).toBe('app');
    const mounts = p.args.flatMap((a, i) => (a === '-v' ? [p.args[i + 1]] : []));
    expect(mounts).toEqual(['/host/probe.crt:/primary-ca.crt:ro', `${containerManager.hostBotDirFor('a')}/fleet-join/push-restore.list:/tmp/smdb-restore.list:ro`]);
    expect(p.list).toBe(restoreLists(TOC, MANAGER_TOC).other);
    expect(p.list).not.toContain('smdb_manager');
    for (const x of runs.filter(y => y.step !== 'push')) expect(x.args.join(' ')).not.toContain('smdb-restore.list');
    expect(fs.existsSync(path.join(tmp.dir, 'bots', 'a', 'fleet-join', 'push-restore.list'))).toBe(false);
  });
  it('S2: a failed pg_restore also removes the list file', async () => {
    answers.push = bad('pg_restore: error: could not execute query');
    expect((await push('a', CODE)).success).toBe(false);
    expect(run('push').list).toBe(restoreLists(TOC, MANAGER_TOC).other);
    expect(fs.existsSync(path.join(tmp.dir, 'bots', 'a', 'fleet-join', 'push-restore.list'))).toBe(false);
  });
  it('Y1: counts and checksums leave smdb_manager.addresses out, and the skipped rows are logged once', async () => {
    const good = Array.from({ length: 1001 }, (_v, i) => addressRow(`host${i}.example`, 5000 + i));
    g.meta = metaDump(entry('addresses', ADDR_COLS, [addressRow('zero.example', 0), addressRow('late.example', 5433, undefined, 'infinity'), addressRow('bad.example', 5433, 'not a certificate'), ...good]), GENERATION);
    fs.writeFileSync(path.join(DIR, `${FILE}.json`), JSON.stringify({ file: FILE, takenAt: 1, family: 'main', kind: 'safety', inRecovery: false, dataAt: null, dbBytes: 1, counts: { '"public"."t"': 3, 'smdb_manager.addresses': 1004 }, tables: 2, rows: 1007 }));
    answers.counts = ok('count|"public"."t"|3\ncount|smdb_manager.addresses|1001\n');
    answers.sums = ok(`${SUM}\nchecksum|smdb_manager.addresses|ffffffffffffffffffffffffffffffff\n`);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const r = await push('a', CODE);
    expect(r.success).toBe(true);
    expect(warn.mock.calls.filter(c => String(c[0]).includes('smdb_manager.addresses'))).toEqual([['[Switch] A: left out 4 row(s) of smdb_manager.addresses from the pushed dump (3 failed the address check or were over the size limit, 1 past the 1000-row cap)']]);
  });
  it('W11, U2 part 4: the sender resets its own database as dbm_admin on postgres before the dump', async () => {
    expect((await push('a', CODE)).success).toBe(true);
    const [reset] = execs('IS_TEMPLATE false');
    expect(loginOf(reset.args)).toBe('dbm_admin postgres');
    expect(reset.input).toBe('ALTER DATABASE "app" IS_TEMPLATE false;\nALTER DATABASE "app" ALLOW_CONNECTIONS true;\nALTER DATABASE "app" CONNECTION LIMIT -1;\nALTER DATABASE "app" RESET ALL;\nGRANT CONNECT, CREATE ON DATABASE "app" TO dbm_meta;\nGRANT CONNECT ON DATABASE "app" TO dbm_work;\n');
    expect(h.events.indexOf('db-reset')).toBeLessThan(h.events.indexOf('dump:pre-push-'));
  });
  it('W11: a failed reset answers PUSH-RESET; nothing is dumped or sent', async () => {
    fake.dbs['a-pg'].fail['db-reset'] = 'ERROR:  permission denied for database app';
    const r = await push('a', CODE);
    expect(r.text).toBe("The push was refused: this database's own settings could not be reset before the dump (ERROR:  permission denied for database app). Nothing was sent; the other machine is unchanged.");
    expect(h.events).not.toContain('dump:pre-push-');
    expect(runs.map(x => x.step)).toEqual(['probe']);
    expect(stored('a').fleetDb.handover).toBeUndefined();
  });
  it('X1: the sender reads its own dump as text and a row that does not parse answers PUSH-META before anything is sent', async () => {
    g.meta = metaDump(entry('generation', 'one_row, machine, generation, since', [`f\tmain.example\t3\t${TS}`]));
    const parsed = parseMetaRows(g.meta, validAddress);
    if (parsed.ok) throw new Error('the fixture parses');
    const r = await push('a', CODE);
    expect(r.text).toBe(`The push was refused: this database's dump holds smdb_manager rows the manager could not read (${parsed.problem}). Nothing was sent; the other machine is unchanged.`);
    expect(runs.map(x => x.step)).toEqual(['probe']);
    expect(stored('a').fleetDb.handover).toBeUndefined();
    const read = g.restoreReads.find(a => a.includes('--data-only'))!;
    expect(read.slice(read.indexOf('pg_restore'))).toEqual(['pg_restore', '--data-only', '-n', 'smdb_manager', '-f', '-']);
  });
  it.each([
    ['counts', 'smdb_receive'],
    ['sums', 'smdb_receive'],
    ['cap', 'smdb_receive'],
    ['commit', 'smdb_receive_meta'],
  ])('U7, W3: %s refused for the receive login after a good pg_restore answers PUSH-RECVLOGIN', async (step, login) => {
    answers[step] = bad(REFUSED(login));
    const r = await push('a', CODE);
    expect(r).toMatchObject({ success: false, text: RECVLOGIN });
    expect(stored('a').fleetDb.handover).toMatchObject({ phase: 'pushing', lastError: RECVLOGIN });
  });
  it('U7: a login refused before the pg_restore keeps the push failure text', async () => {
    answers.create = bad(REFUSED('smdb_receive_meta'));
    const r = await push('a', CODE);
    expect(r.text).toMatch(/^The push to win\.example failed \(.*\)\. This machine's database is unchanged; win\.example's database is incomplete, and its bot stays Off\. Press Push again with the same code, or Cancel the push\.$/);
  });
  it('P4: the cap runs as smdb_receive before the raise; a failed raise answers Press Push again', async () => {
    answers.commit = bad('ERROR:  could not serialize access');
    const r = await push('a', CODE);
    expect(r.text).toBe('The data reached win.example and matched, but win.example could not be made the main (ERROR:  could not serialize access). Press Push again.');
    expect(runs.map(x => x.step).slice(-2)).toEqual(['cap', 'commit']);
    expect(run('cap').args).toContain(SHARD_CAP_DO_SQL);
    const commit = run('commit').args.join('\n');
    expect(commit).toContain('SET ROLE dbm_meta;');
    expect(commit).not.toContain('dbm_admin');
    expect(commit).not.toContain('shard_claims');
    expect(commit).toContain(`INSERT INTO smdb_manager.received (push_id, from_system_id, from_machine, generation) VALUES ('${PUSH_ID}', '7001', 'main.example', 4) ON CONFLICT (push_id) DO NOTHING`);
  });
  it('Y3: the last step clears what each login owns in the bot database, then removes smdb_receive\'s password and ends its sessions', async () => {
    expect((await push('a', CODE)).success).toBe(true);
    expect(run('last').args.find(a => a.startsWith('postgresql://'))).toContain('/app?');
    expect(run('last').input).toBe('REASSIGN OWNED BY smdb_receive TO "app";\nDROP OWNED BY smdb_receive;\nALTER ROLE smdb_receive PASSWORD NULL;\n'
      + "SELECT pg_catalog.pg_terminate_backend(pid) FROM pg_catalog.pg_stat_activity WHERE usename = 'smdb_receive' AND pid <> pg_catalog.pg_backend_pid();\n");
    expect(run('last-meta').input).toBe('REASSIGN OWNED BY smdb_receive_meta TO "app";\nDROP OWNED BY smdb_receive_meta;\n');
  });
  it('Y3, ruling 4: a failed last step is logged and the push still succeeds', async () => {
    answers.last = bad('ERROR:  role "smdb_receive" cannot be altered');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const r = await push('a', CODE);
    expect(r.success).toBe(true);
    expect(warn).toHaveBeenCalledWith('[Switch] A: the receive login\'s password could not be removed after the push (ERROR:  role "smdb_receive" cannot be altered); the receiving machine removes the move code\'s logins at its own checks of receiving, and until its first check this move code\'s password still opens them');
  });
});

describe('NM20 part 6: the receiver\'s end (Y3, Z1, Q1, P5)', () => {
  const receiving = async () => {
    writeRegistry({ a: mainFixture({ maintenance: OFF }) });
    h.proof = { ok: true, state: 'off', enforcement: 'database', botConfirmed: true };
    expect((await receive('a')).success).toBe(true);
    h.events.length = 0;
    fake.calls.length = 0;
  };
  const END = ['receive-reset', 'receive-end', 'receive-clean:smdb_receive', 'receive-clean:smdb_receive_meta', 'receive-nologin', 'receive-end', 'receive-drop'];
  const endSteps = () => h.events.filter(e => e.startsWith('receive-'));

  it('P5, Y3, Z1: finishReceive resets both logins, ends their sessions, clears each in the bot database, then drops them and clears the confirmed set', async () => {
    await receiving();
    fake.dbs['a-pg'].received.push({ pushId: stored('a').fleetDb.receive.pushId, from: '9', machine: 'win.local', generation: 6 });
    await receiveStep(containerManager.getBot('a')!, Date.now());
    expect(endSteps()).toEqual(END);
    expect(fake.dbs['a-pg'].roles).toEqual({});
    expect(stored('a').fleetDb.receive).toBeUndefined();
    expect(g.faults).toContain('a-pg');
    const [reset] = execs('LOGIN PASSWORD NULL');
    expect(loginOf(reset.args)).toBe('dbm_admin postgres');
    expect(reset.input).toContain("FOREACH l IN ARRAY ARRAY['smdb_receive', 'smdb_receive_meta']");
    expect(reset.input).toContain("EXECUTE pg_catalog.format('ALTER ROLE %I LOGIN PASSWORD NULL', l);");
    expect(reset.input).toContain("EXECUTE pg_catalog.format('ALTER ROLE %I RESET ALL', l);");
    expect(reset.input).toContain("EXECUTE pg_catalog.format('ALTER ROLE %I IN DATABASE %I RESET ALL', l, 'app');");
    expect(reset.input).toContain("IF EXISTS (SELECT 1 FROM pg_catalog.pg_database WHERE datname = 'app') THEN");
    for (const s of ['IS_TEMPLATE false', 'ALLOW_CONNECTIONS true', 'CONNECTION LIMIT -1', 'RESET ALL', 'GRANT CONNECT, CREATE ON DATABASE %I TO dbm_meta', 'GRANT CONNECT ON DATABASE %I TO dbm_work']) {
      expect(reset.input).toContain(`EXECUTE pg_catalog.format('${s.startsWith('GRANT') ? s : `ALTER DATABASE %I ${s}`}', 'app');`);
    }
    for (const login of ['smdb_receive', 'smdb_receive_meta']) {
      const [clean] = execs(`REASSIGN OWNED BY ${login} TO`);
      expect(clean.args.slice(0, 4)).toEqual(['exec', '-e', PINS_EXEMPT, '-i']);
      expect(loginOf(clean.args)).toBe(`${login} app`);
      expect(clean.input).toBe(`REASSIGN OWNED BY ${login} TO "app";\nDROP OWNED BY ${login};\n`);
    }
  });
  it('Q1: with no bot database, the cleanup sessions are skipped and both logins are dropped', async () => {
    await receiving();
    fake.dbs['a-pg'].botDbMissing = true;
    await stopReceive('a');
    expect(endSteps()).toEqual(['receive-reset', 'receive-end', 'receive-nologin', 'receive-end', 'receive-drop']);
    expect(fake.dbs['a-pg'].roles).toEqual({});
  });
  it('Z1, Q1: a failed cleanup closes both logins (NOLOGIN, no password) and ends their sessions without the drop; the next call drops them', async () => {
    await receiving();
    fake.dbs['a-pg'].fail['receive-clean'] = 'ERROR:  permission denied to reassign objects';
    const r = await stopReceive('a');
    expect(r.text).toBe('The receive login could not be removed (ERROR:  permission denied to reassign objects); try again.');
    expect(endSteps()).toEqual(['receive-reset', 'receive-end', 'receive-clean:smdb_receive', 'receive-close', 'receive-end']);
    const roles = fake.dbs['a-pg'].roles;
    expect([roles.smdb_receive, roles.smdb_receive_meta].map(x => [x.canLogin, x.password])).toEqual([[false, ''], [false, '']]);
    const [close] = execs('NOLOGIN PASSWORD NULL');
    expect(loginOf(close.args)).toBe('dbm_admin postgres');
    expect(close.input).toContain("EXECUTE pg_catalog.format('ALTER ROLE %I NOLOGIN PASSWORD NULL', l);");
    delete fake.dbs['a-pg'].fail['receive-clean'];
    h.events.length = 0;
    expect(await stopReceive('a')).toMatchObject({ success: true });
    expect(endSteps()).toEqual(END);
    expect(fake.dbs['a-pg'].roles).toEqual({});
  });
  it('Q1: a failed step 1 also closes both logins, and a close that fails too follows the first error', async () => {
    await receiving();
    fake.dbs['a-pg'].fail['receive-reset'] = 'ERROR:  out of shared memory';
    expect((await stopReceive('a')).text).toBe('The receive login could not be removed (ERROR:  out of shared memory); try again.');
    expect(endSteps()).toEqual(['receive-reset', 'receive-close', 'receive-end']);
    fake.dbs['a-pg'].fail['receive-close'] = 'ERROR:  lock timeout';
    h.events.length = 0;
    expect((await stopReceive('a')).text).toBe('The receive login could not be removed (ERROR:  out of shared memory; closing the logins also failed: ERROR:  lock timeout); try again.');
    expect(endSteps()).toEqual(['receive-reset', 'receive-close']);
  });
  it('Y3: the expiry path logs a failed end once per distinct error', async () => {
    await receiving();
    fake.dbs['a-pg'].fail['receive-clean'] = 'ERROR:  first';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const later = Date.now() + 25 * 60 * 60_000;
    const lines = () => warn.mock.calls.map(c => String(c[0])).filter(l => l.includes('the move code expired, but the receive login could not be removed'));
    await receiveStep(containerManager.getBot('a')!, later);
    await receiveStep(containerManager.getBot('a')!, later);
    expect(lines()).toEqual(['[Switch] A: the move code expired, but the receive login could not be removed (ERROR:  first); the manager tries again every minute']);
    fake.dbs['a-pg'].fail['receive-clean'] = 'ERROR:  second';
    await receiveStep(containerManager.getBot('a')!, later);
    expect(lines()).toHaveLength(2);
    expect(lines()[1]).toContain('(ERROR:  second)');
  });
});

describe('NM20 part 6: the copy fallback is gone (3.3, R3.3)', () => {
  it('dbLogin exports no asManager, withRole or copy fallback, and fleetSwitch no adminSql', async () => {
    const db = await vi.importActual<Record<string, unknown>>('../../src/instance/dbLogin');
    const sw = await vi.importActual<Record<string, unknown>>('../../src/instance/fleetSwitch');
    expect(['asManager', 'withRole', 'copyFallbackLogged'].filter(k => k in db)).toEqual([]);
    expect('adminSql' in sw).toBe(false);
  });
});


describe('fix 5b: the push TOC cap, the end\'s single round and Receive\'s join code (C1, C8, G1)', () => {
  const offReceive = async (fleetDb: Record<string, unknown> = mainFixture().fleetDb as Record<string, unknown>) => {
    writeRegistry({ a: mainFixture({ fleetDb, maintenance: OFF }) });
    h.proof = { ok: true, state: 'off', enforcement: 'database', botConfirmed: true };
    return receive('a');
  };

  it('C1: a table of contents at the 8 MB cap refuses the push before any receiver step', async () => {
    g.toc = `${TOC}${'; x\n'.repeat(Math.ceil(8 * 1024 * 1024 / 4))}`;
    const r = await push('a', CODE);
    expect(r).toMatchObject({ success: false, text: "The push was refused: this database's dump could not be read (its table of contents is longer than 8 MB, so the restore list made from it could miss an entry). Nothing was sent; the other machine is unchanged." });
    expect(runs.map(x => x.step)).toEqual(['probe']);
    expect(stored('a').fleetDb.handover).toBeUndefined();
  }, 60000);

  it('C8: a session left after the single round of step 4 is answered without "three tries"', async () => {
    expect((await offReceive()).success).toBe(true);
    const d = fake.dbs['a-pg'];
    const late = () => h.events.includes('receive-nologin');
    Object.defineProperty(d.sessions, 'smdb_receive', { get: () => (late() ? 1 : 0), set: () => undefined, configurable: true });
    Object.defineProperty(d.pinnedSessions, 'smdb_receive', { get: late, configurable: true });
    const r = await stopReceive('a');
    expect(r).toMatchObject({ success: false, text: 'The receive login no longer accepts new sessions, but 1 of its session(s) did not end, so receiving was not stopped; press Stop receiving again.' });
  });

  it('G1: Receive pressed again while receiving asks for the join code without provisioning', async () => {
    expect((await offReceive()).success).toBe(true);
    tmp.joinCalls.length = 0;
    const again = await receive('a');
    expect(again.success).toBe(true);
    expect(stored('a').fleetDb.receive).toBeDefined();
    expect(tmp.joinCalls).toHaveLength(1);
    expect(tmp.joinCalls[0][1]).toEqual({ forReceive: true });
  });

  it('G1: Receive after a broken push asks for the join code without provisioning', async () => {
    const r = await offReceive({ ...(mainFixture().fleetDb as object), pushBroken: { at: '2026-11-13T00:00:00.000Z', safetyDump: 'pre-receive-old.dump' } });
    expect(r.success).toBe(true);
    expect(tmp.joinCalls).toHaveLength(1);
    expect(tmp.joinCalls[0][1]).toEqual({ forReceive: true });
  });

  it('G1: the first Receive, with neither flag set, passes the same option (getJoinCode provisions there: neither flag is set)', async () => {
    const r = await offReceive();
    expect(r.success).toBe(true);
    expect(tmp.joinCalls).toHaveLength(1);
    const inst = tmp.joinCalls[0][0] as { fleetDb: Record<string, unknown> };
    expect(inst.fleetDb.receive).toBeUndefined();
    expect(inst.fleetDb.pushBroken).toBeUndefined();
    expect(tmp.joinCalls[0][1]).toEqual({ forReceive: true });
  });
});
