// A fake docker for the switch lanes: `docker exec -i <container> psql ... -d <db>` scripts on stdin are answered from
// an in-memory database per container (the section 2.1 tables, slots, the restore record, the read-only layer), and
// `docker run` client containers (peer probes, the receiver) by a handler the test sets. Every call is logged.
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';

export interface GenFake { generation: number; machine: string; since: string | null }
export interface SlotFake { active: boolean; state: string; replay: string; client?: string }
export interface AddressFake { host: string; port: number; slot: string | null; machine: string; cert: string }

export interface FakeDb {
  generation: GenFake | null;
  /** false: the smdb_manager tables do not exist. */
  tables: boolean;
  handover: { slot: string; machine: string; generation: number } | null;
  /** Keyed by the push id (D41). */
  received: Array<{ pushId: string; from: string; machine: string; generation: number }>;
  /** smdb_manager.copies (D50); null: the table does not exist. */
  copies: Array<{ slot: string; machine: string | null; client: string | null }> | null;
  /** The bot database's oid in pg_database; a push's DROP and CREATE change it. */
  dbOid: string;
  /** The LSN the hand-over row's delete answers; the current LSN when unset. */
  deleteLsn: string | null;
  /** Awaited before each psql answer: a row holds the lane at a known step until it resolves. */
  beforeAnswer: ((sql: string) => Promise<void> | void) | null;
  addresses: AddressFake[];
  restoreState: { pending: boolean; file: string; at: string; generation: number; machine: string; since: string | null } | null;
  readOnly: boolean;
  recovery: boolean;
  botDbMissing: boolean;
  slots: Record<string, SlotFake>;
  currentLsn: string;
  receiveLsn: string;
  replayLsn: string;
  replayTs: string;
  systemId: string;
  promote: 't' | 'f' | 'error';
  /** A step name (see the answer function) mapped to the stderr it fails with. */
  fail: Record<string, string>;
  roles: Record<string, { password: string; until: string; canLogin?: boolean }>;
  /** The cluster's other role names (replicationRoleEnsureSql adds to it). */
  clusterRoles: string[];
  /** Open sessions per role; RECEIVE_END_SQL ends them unless the role is pinned. */
  sessions: Record<string, number>;
  pinnedSessions: Record<string, boolean>;
  /** Called before each slot read; lets a test move replay forward. */
  onSlotRead: (() => void) | null;
  /** The take-over line in the pg_hba file, and whether the server has reloaded it. */
  hbaFileBlock: boolean;
  hbaLive: boolean;
  hbaFile: string;
  /** authentication_timeout in seconds, as pg_settings answers it. */
  authTimeout: string;
  /** smdb_manager.receive_mark in the cluster's postgres database (D62). */
  receiveMark: { markId: string; pushIds: string[]; dbOid: string } | null;
  /** false: the receive_mark table does not exist. */
  markTable: boolean;
}

export function freshDb(over: Partial<FakeDb> = {}): FakeDb {
  return {
    generation: { generation: 3, machine: 'main.example', since: '2026-10-28T10:00:00Z' }, tables: true, handover: null, received: [], addresses: [],
    copies: [], dbOid: '16384', deleteLsn: null, beforeAnswer: null, restoreState: null, readOnly: false, recovery: false, botDbMissing: false, slots: {}, currentLsn: '0/5000000', receiveLsn: '0/5000000',
    replayLsn: '0/5000000', replayTs: '2026-10-28T11:00:00Z', systemId: '7001', promote: 't', fail: {}, roles: {}, clusterRoles: ['app', 'dbm_admin', 'replicator'], sessions: {}, pinnedSessions: {}, onSlotRead: null,
    hbaFileBlock: false, hbaLive: false, hbaFile: '/var/lib/postgresql/data/pg_hba.conf', authTimeout: '0', receiveMark: null, markTable: true, ...over,
  };
}

export const fake = ((globalThis as { __switchFake?: { dbs: Record<string, FakeDb>; calls: Array<{ args: string[]; input: string }>; run: RunHandler | null; onEvent: ((e: string) => void) | null } }).__switchFake ??= { dbs: {}, calls: [], run: null, onEvent: null });
const emit = (e: string) => fake.onEvent?.(e);

export type RunHandler = (args: string[], env: Record<string, string | undefined>, input: string) => { code: number; stdout: string; stderr: string };

export function resetFake(): void {
  fake.dbs = {};
  fake.calls = [];
  fake.run = null;
  fake.onEvent = null;
}

const NO_TABLE = (t: string) => `ERROR:  relation "smdb_manager.${t}" does not exist`;
const lsnNum = (l: string) => { const [a, b] = l.split('/'); return (BigInt(`0x${a}`) << 32n) + BigInt(`0x${b}`); };
const genLine = (g: GenFake | null) => (g ? `${g.generation}|${g.machine}|${g.since ?? ''}` : '0||');

type Answer = { code: number; stdout: string; stderr: string };
const ok = (stdout = ''): Answer => ({ code: 0, stdout, stderr: '' });
const err = (stderr: string): Answer => ({ code: 1, stdout: '', stderr });

/** The answer of one psql script against the fake database of a container. */
export function answerSql(container: string, dbName: string, sql: string): Answer {
  const d = fake.dbs[container];
  if (!d) return err(`Error response from daemon: No such container: ${container}`);
  const failing = (step: string) => (d.fail[step] !== undefined ? err(d.fail[step]) : null);
  const out: string[] = [];
  if (sql.includes('INSERT INTO smdb_manager.receive_mark')) {
    emit('mark-write');
    const f = failing('mark-write');
    if (f) return f;
    const m = /VALUES \(true, '([^']*)', '([^']*)', '([^']*)', now\(\)\)/.exec(sql)!;
    d.markTable = true;
    d.receiveMark = { markId: m[1], pushIds: m[2].split(','), dbOid: m[3] };
    return ok();
  }
  if (sql.includes("FROM smdb_manager.receive_mark), '')")) {
    emit('mark-read');
    const f = failing('mark-read');
    if (f) return f;
    if (!d.markTable) return err(NO_TABLE('receive_mark'));
    const r = d.receiveMark;
    return ok(r ? `${r.markId}|${r.pushIds.join(',')}|${r.dbOid}\n` : '\n');
  }
  if (sql.includes('DELETE FROM smdb_manager.receive_mark')) {
    emit('mark-clear');
    const f = failing('mark-clear');
    if (f) return f;
    const id = /WHERE mark_id = '([^']*)'/.exec(sql)?.[1];
    if (d.receiveMark && (id === undefined || d.receiveMark.markId === id)) d.receiveMark = null;
    return ok();
  }
  if (sql.includes('INSERT INTO smdb_manager.copies AS c')) {
    emit('copies-sync');
    const f = failing('copies-sync');
    if (f) return f;
    if (d.copies === null && sql.includes('CREATE TABLE IF NOT EXISTS smdb_manager.copies')) d.copies = [];
    if (d.copies === null) return err(NO_TABLE('copies'));
    const rows = d.copies.filter(c => d.slots[c.slot]);
    for (const [slot, sf] of Object.entries(d.slots)) {
      const machine = d.addresses.find(a => a.slot === slot)?.machine ?? null;
      const client = sf.active ? sf.client ?? null : null;
      const row = rows.find(c => c.slot === slot);
      if (row) { row.machine = machine ?? row.machine; row.client = client ?? row.client; } else rows.push({ slot, machine, client });
    }
    d.copies = rows;
    if (sql.trimStart().startsWith('DELETE FROM smdb_manager.copies')) return ok();
  }
  if (sql.includes('FROM smdb_manager.copies WHERE slot <>')) {
    const f = failing('copies-read');
    if (f) return f;
    if (d.copies === null) return err(NO_TABLE('copies'));
    const own = /WHERE slot <> '([^']*)'/.exec(sql)![1];
    return ok(`${[...d.copies].filter(c => c.slot !== own).sort((x, y) => x.slot.localeCompare(y.slot)).map(c => `${c.machine ?? ''}|${c.client ?? ''}`).join(',')}\n`);
  }
  if (sql.includes("json_build_object('host', host") && sql.includes('FROM smdb_manager.addresses a WHERE slot IS NOT NULL')) {
    emit('own-copies');
    const f = failing('own-copies');
    if (f) return f;
    return ok(`${JSON.stringify(d.addresses.filter(a => a.slot !== null && d.slots[a.slot]).map(a => ({ host: a.host, port: a.port, slot: a.slot, cert: a.cert, machine: a.machine })))}\n`);
  }
  if (sql.includes('INSERT INTO smdb_manager.addresses (host, port, slot, cert, machine) SELECT')) {
    emit('copies-insert');
    const f = failing('copies-insert');
    if (f) return f;
    for (const m of sql.matchAll(/SELECT '((?:[^']|'')*)', (\d+), '((?:[^']|'')*)', '((?:[^']|'')*)', '((?:[^']|'')*)' WHERE EXISTS/g)) {
      const un = (v: string) => v.replace(/''/g, "'");
      const row = { host: un(m[1]), port: Number(m[2]), slot: un(m[3]), cert: un(m[4]), machine: un(m[5]) };
      if (d.slots[row.slot] && !d.addresses.some(a => a.host === row.host && a.port === row.port)) d.addresses.push(row);
    }
    if (!sql.includes('INSERT INTO smdb_manager.generation')) return ok();
  }
  if (sql.includes('CREATE ROLE') && sql.includes('NOLOGIN REPLICATION')) {
    emit('role-ensure');
    const f = failing('role-ensure');
    if (f) return f;
    const role = /CREATE ROLE ([a-z_]+) NOLOGIN/.exec(sql)![1];
    if (!d.clusterRoles.includes(role)) d.clusterRoles.push(role);
    return ok();
  }
  if (sql.includes('FROM smdb_manager.addresses a WHERE slot IS NOT NULL AND host =')) {
    emit('former-listed');
    const f = failing('former-listed');
    if (f) return f;
    if (!d.tables) return err(NO_TABLE('addresses'));
    const m = /AND host = '([^']*)' AND port = (\d+)/.exec(sql)!;
    return ok(`${d.addresses.filter(a => a.slot !== null && d.slots[a.slot] && a.host === m[1] && a.port === Number(m[2])).length}\n`);
  }
  if (sql.includes('oid::text FROM pg_database WHERE datname')) {
    emit('oid-read');
    const f = failing('oid-read');
    if (f) return f;
    return ok(`${d.botDbMissing ? '' : d.dbOid}\n`);
  }
  if (sql.includes('count(*) FROM smdb_manager.received WHERE push_id')) {
    const f = failing('received-read');
    if (f) return f;
    if (!d.tables) return err(NO_TABLE('received'));
    const id = /push_id = '([^']*)'/.exec(sql)![1];
    return ok(`${d.received.filter(r => r.pushId === id).length}\n`);
  }
  if (sql.includes('FROM smdb_manager.received WHERE push_id IN (')) {
    emit('received-read');
    const f = failing('received-read');
    if (f) return f;
    if (!d.tables) return err(NO_TABLE('received'));
    const list = /push_id IN \(([^)]*)\)/.exec(sql)![1];
    const ids = [...list.matchAll(/'([^']*)'/g)].map(m => m[1]);
    const r = [...d.received].reverse().find(x => ids.includes(x.pushId));
    return ok(r ? `${r.machine}|${r.generation}\n` : '\n');
  }
  if (sql.includes('FROM smdb_manager.received WHERE push_id')) {
    const f = failing('received-read');
    if (f) return f;
    if (!d.tables) return err(NO_TABLE('received'));
    const id = /push_id = '([^']*)'/.exec(sql)![1];
    const r = d.received.find(x => x.pushId === id);
    return ok(r ? `${r.machine}|${r.generation}\n` : '\n');
  }
  if (sql.includes("current_setting('hba_file')")) return failing('hba-file') ?? ok(`${d.hbaFile}\n`);
  if (sql.includes('pg_reload_conf()')) {
    emit('reload');
    const f = failing('reload');
    if (f) return f;
    d.hbaLive = d.hbaFileBlock;
    return ok('t\n');
  }
  if (sql.includes("name = 'authentication_timeout'")) return ok(`${d.authTimeout}\n`);
  if (sql.includes('pg_promote(')) {
    emit('promote');
    const f = failing('promote');
    if (f) return f;
    if (d.promote === 'error') return err('ERROR:  promote failed');
    if (d.promote === 't') d.recovery = false;
    return ok(`${d.promote}\n`);
  }
  if (sql.includes('FROM pg_database WHERE datname')) return failing('exists') ?? ok(d.botDbMissing ? '0\n' : '1\n');
  if (sql.includes('FROM smdb_manager.restore_state')) {
    const f = failing('restore-read');
    if (f) return f;
    if (!d.restoreState) return err(NO_TABLE('restore_state'));
    const r = d.restoreState;
    return ok(`${r.pending}|${r.file}|${r.at}|${r.generation}|${r.machine}|${r.since ?? ''}\n`);
  }
  if (sql.includes('UPDATE smdb_manager.restore_state SET pending = false')) {
    const f = failing('restore-clear');
    if (f) return f;
    if (d.restoreState) d.restoreState.pending = false;
    return ok();
  }
  if (sql.includes('DO $$ BEGIN\nIF NOT pg_is_in_recovery()')) {
    const f = failing('ensure');
    if (f) return f;
    if (d.readOnly) return err('ERROR:  cannot execute CREATE SCHEMA in a read-only transaction');
    if (!d.recovery) {
      d.tables = true;
      const m = /VALUES \(true, '([^']*)', 1\)/.exec(sql);
      if (!d.generation) d.generation = { generation: 1, machine: m?.[1] ?? '', since: '2026-10-28T12:00:00Z' };
    }
    return ok();
  }
  if (sql.includes('INSERT INTO smdb_manager.handover')) {
    const f = failing('handover-row');
    if (f) return f;
    if (d.readOnly) return err('ERROR:  cannot execute INSERT in a read-only transaction');
    const m = /VALUES \('([^']*)', '([^']*)', (\d+)\)/.exec(sql)!;
    d.handover = { slot: m[1], machine: m[2], generation: Number(m[3]) };
    return ok(`${d.currentLsn}\n`);
  }
  if (sql.includes('INSERT INTO smdb_manager.generation AS g')) {
    emit('raise');
    const f = failing('raise');
    if (f) return f;
    if (d.readOnly) return err('ERROR:  cannot execute INSERT in a read-only transaction');
    const m = /VALUES \(true, '([^']*)', (\d+), now\(\)\)/.exec(sql)!;
    const target = Number(m[2]);
    d.tables = true;
    if (!d.generation || d.generation.generation < target) d.generation = { generation: target, machine: m[1], since: '2026-10-28T13:00:00Z' };
    d.handover = null;
    if (sql.includes('DELETE FROM smdb_manager.addresses WHERE slot IS NOT NULL')) d.addresses = d.addresses.filter(a => a.slot === null);
    const old = /host = %L AND port = (\d+)', '([^']*)'\)/.exec(sql);
    if (old) d.addresses = d.addresses.filter(a => !(a.slot === null && a.host === old[2] && a.port === Number(old[1])));
    return ok(`${genLine(d.generation)}\n`);
  }
  if (sql.trim().startsWith('DELETE FROM smdb_manager.handover;')) {
    const f = failing('handover-delete');
    if (f) return f;
    if (!d.tables) return err(NO_TABLE('handover'));
    d.handover = null;
    emit('handover-delete');
    return ok(sql.includes('pg_current_wal_lsn()') ? `${d.deleteLsn ?? d.currentLsn}\n` : '');
  }
  if (sql.includes('FROM smdb_manager.generation), \'0||\')')) {
    const f = failing('gen-read');
    if (f) return f;
    if (!d.tables) return err(NO_TABLE('generation'));
    return ok(`${genLine(d.generation)}\n`);
  }
  if (sql.includes('FROM smdb_manager.handover), \'\')')) {
    const f = failing('handover-read');
    if (f) return f;
    if (!d.tables) return err(NO_TABLE('handover'));
    return ok(d.handover ? `${d.handover.slot}|${d.handover.generation}|${d.handover.machine}\n` : '\n');
  }
  if (sql.includes('pg_last_xact_replay_timestamp()')) {
    const f = failing('replay');
    if (f) return f;
    return ok(`${d.replayTs}|${d.receiveLsn}|${d.replayLsn}\n`);
  }
  if (sql.includes('FROM pg_replication_slots s LEFT JOIN pg_stat_replication r ON r.pid = s.active_pid WHERE s.slot_name')) {
    d.onSlotRead?.();
    const f = failing('slot-read');
    if (f) return f;
    const slot = /s\.slot_name = '([^']*)'/.exec(sql)![1];
    const s = d.slots[slot];
    out.push(s ? `${s.active}|${s.state}|${s.replay}` : 'absent');
    if (sql.includes("'addr|'")) {
      if (!d.tables) return { code: 1, stdout: `${out.join('\n')}\n`, stderr: NO_TABLE('addresses') };
      const a = d.addresses.find(x => x.slot === slot);
      out.push(a ? `addr|${a.host}|${a.port}|${a.machine}|${a.cert.replace(/\n/g, '~')}` : 'addr|');
    }
    return ok(`${out.join('\n')}\n`);
  }
  if (sql.includes("SELECT 'addr|'") && sql.includes('WHERE slot IS NOT NULL')) {
    return ok(d.addresses.filter(a => a.slot !== null).map(a => `addr|${a.host}|${a.port}|${a.machine}|${a.cert.replace(/\n/g, '~')}`).join('\n') + '\n');
  }
  if (sql.includes('s.slot_type = \'physical\'')) {
    return ok(Object.entries(d.slots).map(([slot, s]) => `${slot}|${s.active && s.state === 'streaming'}|${d.addresses.find(a => a.slot === slot)?.machine ?? slot}`).join('\n') + '\n');
  }
  if (sql.includes('pg_control_system()')) return ok(`${d.systemId}\n`);
  if (sql.includes('smdb_receive')) {
    const step = sql.includes('ALTER ROLE smdb_receive NOLOGIN') ? 'receive-nologin' : sql.includes('pg_terminate_backend') ? 'receive-end' : sql.includes('DROP ROLE') ? 'receive-drop' : 'receive-role';
    emit(step);
    const f = failing(step) ?? failing('role');
    if (f) return f;
    if (step === 'receive-nologin') { if (d.roles.smdb_receive) d.roles.smdb_receive.canLogin = false; return ok(); }
    if (step === 'receive-end') {
      const open = d.sessions.smdb_receive ?? 0;
      const ended = d.pinnedSessions.smdb_receive ? 0 : open;
      d.sessions.smdb_receive = open - ended;
      return ok(`${ended}\n${d.sessions.smdb_receive}\n`);
    }
    if (step === 'receive-drop') { delete d.roles.smdb_receive; return ok(); }
    const m = /PASSWORD '([^']*)' VALID UNTIL '([^']*)'/.exec(sql)!;
    d.roles.smdb_receive = { password: m[1], until: m[2], canLogin: true };
    return ok();
  }
  if (sql.startsWith("SELECT 'checksum|'")) {
    const f = failing('checksum');
    if (f) return f;
    return ok('checksum|"public"."t"|0123456789abcdef0123456789abcdef\n');
  }
  return ok();
}

function child(answer: () => Answer | Promise<Answer>, onInput?: (text: string) => void): any {
  const c: any = new EventEmitter();
  c.stdout = new PassThrough();
  c.stderr = new PassThrough();
  c.stdin = new PassThrough();
  let input = '';
  c.stdin.on('data', (d: Buffer) => { input += d.toString(); });
  c.kill = () => true;
  c.stdin.on('finish', async () => {
    onInput?.(input);
    const a = await answer.call(null);
    setTimeout(() => {
      c.stdout.end(a.stdout);
      c.stderr.end(a.stderr);
      setTimeout(() => c.emit('close', a.code), 1);
    }, 1);
  });
  return c;
}

/** The spawn the switch lanes use: docker exec psql on stdin, docker run clients, docker rm. */
export function switchSpawn(cmd: string, args: string[], opts?: { env?: Record<string, string | undefined> }): any {
  const entry = { args, input: '' };
  fake.calls.push(entry);
  if (cmd !== 'docker') return child(() => ok());
  if (args[0] === 'rm') return child(() => ok());
  if (args[0] === 'exec' && args[1] === '-u' && args[2] === 'root') {
    const d = fake.dbs[args[3]];
    const script = args[args.length - 1];
    const lift = script.includes('sed -i');
    emit(lift ? 'hba-lift' : 'hba-block');
    return child(() => {
      const f = d?.fail[lift ? 'lift-script' : 'block-script'];
      if (!d || f !== undefined) return err(f ?? 'no such container');
      d.hbaFileBlock = !lift;
      return ok();
    });
  }
  if (args[0] === 'exec' && args.includes('-h') && args.includes('127.0.0.1')) {
    const d = fake.dbs[args[1]];
    emit('hba-probe');
    return child(() => (d?.hbaLive
      ? { code: 2, stdout: '', stderr: `psql: error: connection to server at "127.0.0.1", port 5432 failed: FATAL:  pg_hba.conf rejects connection for host "127.0.0.1", user "${args[args.indexOf('-U') + 1]}", database "app", no encryption\n` }
      : ok('1\n')));
  }
  if (args[0] === 'exec' && args.includes('psql')) {
    const container = args[args.indexOf('psql') - 1];
    const db = args[args.indexOf('-d') + 1];
    let text = '';
    return child(async () => { await fake.dbs[container]?.beforeAnswer?.(text); return answerSql(container, db, text); }, t => { text = t; entry.input = t; });
  }
  if (args[0] === 'run') {
    let text = '';
    return child(() => (fake.run ? fake.run(args, opts?.env ?? {}, text) : ok()), t => { text = t; entry.input = t; });
  }
  return child(() => ok());
}
