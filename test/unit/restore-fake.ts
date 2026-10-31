// The restore's claim floor and maintenance guard, answered the way a database on contract 8's schema answers them, for
// fake docker CLIs written before the restore read the bot's login, its claim numbers and the dump's table of contents.
// withRestoreFakes wraps an execFile fake and withTocFake a spawn fake; every other call passes to the wrapped fake.
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';

type Cb = (err: Error | null, stdout: string, stderr: string) => void;
type ExecFileFake = (cmd: string, args: string[], optsOrCb: unknown, maybeCb?: unknown) => unknown;
type SpawnFake = (cmd: string, args: string[], opts?: any) => any;

export type TocShape = 'claims' | 'terms' | 'none' | 'empty' | 'emptyNeg' | 'shards' | 'shardsNoClock' | 'clockOnly';

export interface ClaimDb {
  /** readBotLogin's answer: recovery|canlogin|sessions. */
  login: string;
  /** The claim tables probe before the drop: claim_seq|guild_ownership|claim column|shard_claims|claim_clock. */
  tables: string;
  /** The claim floor probe's answer. */
  floor: string;
  /** The raise statement's answer. */
  raise: string;
  /** The claim tables probe after the drop, in the same five fields. */
  restoredTables: string;
  /** The no-floor cap statement's answer. */
  cap: string;
  toc: TocShape;
  fail: null | 'login' | 'tables' | 'floor' | 'raise' | 'cap' | 'toc' | 'restored' | 'gen' | 'state' | 'genwrite' | 'clear' | 'owncopies' | 'ensure' | 'markclear';
  /** The receive mark removals (D62, S23), each its argv joined. */
  markClears: string[];
  /** OWN_COPIES_READ_SQL's answer before the drop of a moved- restore (D49). */
  ownCopies: string;
  /** The generation row of the bot's database before the drop (null: no table), and of the restored dump. */
  generation: GenFake | null;
  restoredGeneration: GenFake | null;
  /** The restore record in the postgres database (null: no table). */
  restoreState: (GenFake & { pending: boolean; file: string }) | null;
  /** The generation writes after the restore (the carry or the raise), in order. */
  genWrites: string[];
  /** Every O9 call by its step name, in order. */
  genEvents: string[];
  /** The stderr a failing claim call answers; null for a fixed ERROR line. */
  failText: string | null;
  /** The TOC read's exit code when fail is 'toc'. */
  tocCode: number;
  dropSeen: boolean;
  /** The argv of step 7's recreate (the call that holds the replication role ensure, D59). */
  recreateArgs: string[] | null;
  raiseSql: string[];
  capSql: string[];
  tocReads: number;
  tocInput: number;
  loginReads: number;
  onRaise: (() => void) | null;
  onToc: (() => void) | null;
  /** Called when the recreate drops the database, after dropSeen is set. */
  onDrop: (() => void) | null;
}

export interface GenFake { generation: number; machine: string; since: string | null }

export function freshClaimDb(): ClaimDb {
  return {
    login: 'false|false|0', tables: 't|t|t|f|f', floor: '7', raise: 'seq|8\nguild|g1\nguild|g2\n', restoredTables: 't|t|t|f|f', cap: 'clock|1000\nrows|2\ncapped|2\n', toc: 'claims',
    fail: null, failText: null, tocCode: 1, dropSeen: false, recreateArgs: null, raiseSql: [], capSql: [], tocReads: 0, tocInput: 0, loginReads: 0, onRaise: null, onToc: null, onDrop: null,
    generation: null, restoredGeneration: null, restoreState: null, genWrites: [], genEvents: [], ownCopies: '[]', markClears: [],
  };
}

const genLine = (g: GenFake | null) => (g ? `${g.generation}|${g.machine}|${g.since ?? ''}` : '0||');
const NO_GEN = 'ERROR:  relation "smdb_manager.generation" does not exist';

export const claimDb: ClaimDb = ((globalThis as { __claimDb?: ClaimDb }).__claimDb ??= freshClaimDb());

export function resetClaimDb(over: Partial<ClaimDb> = {}): void {
  Object.assign(claimDb, freshClaimDb(), over);
}

/** The settled Maintenance a restore admits, and the settled Off. */
export const MAINTAINED = { maintenance: { state: 'maintenance', message: '', orderedAt: '2026-10-28T00:00:00.000Z', settled: true, hook: 'confirmed', login: 'blocked', savedByBot: 'maintenance' } };
export const OFF = { maintenance: { state: 'off', message: '', orderedAt: '2026-10-28T00:00:00.000Z', settled: true, hook: 'confirmed', login: 'blocked', savedByBot: 'maintenance' } };

const HEAD = ';\n; Archive created at 2026-10-28 10:00:00 UTC\n;     dbname: app\n;     TOC Entries: 12\n;     Compression: gzip\n;     Dump Version: 1.15-0\n;     Format: CUSTOM\n;     Integer: 4 bytes\n;     Offset: 8 bytes\n;     Dumped from database version: 16.4\n;     Dumped by pg_dump version: 16.4\n;\n;\n; Selected TOC Entries:\n;\n';

/** pg_restore -l of PostgreSQL 16 for a dump on contract 8's schema, on the term schema, with neither table, with the
 * shard claims and the claim clock, with the shard claims alone, and with the claim clock alone; empty is the header
 * alone, as for a database with no objects. */
const TOC_CLAIMS = `${HEAD}5; 2615 16385 SCHEMA - smdb_data app\n216; 1259 16386 TABLE smdb_data guild_ownership app\n217; 1259 16392 SEQUENCE smdb_data claim_seq app\n215; 1259 16400 TABLE smdb_data meta app\n3360; 0 16386 TABLE DATA smdb_data guild_ownership app\n3361; 0 16400 TABLE DATA smdb_data meta app\n3367; 0 0 SEQUENCE SET smdb_data claim_seq app\n3200; 2606 16391 CONSTRAINT smdb_data guild_ownership guild_ownership_pkey app\n`;

export const TOC: Record<TocShape, string> = {
  claims: TOC_CLAIMS,
  terms: `${HEAD}5; 2615 16385 SCHEMA - smdb_data app\n216; 1259 16386 TABLE smdb_data guild_ownership app\n215; 1259 16400 TABLE smdb_data meta app\n3360; 0 16386 TABLE DATA smdb_data guild_ownership app\n3361; 0 16400 TABLE DATA smdb_data meta app\n3200; 2606 16391 CONSTRAINT smdb_data guild_ownership guild_ownership_pkey app\n`,
  none: `${HEAD}5; 2615 16385 SCHEMA - public app\n215; 1259 16400 TABLE public t app\n3361; 0 16400 TABLE DATA public t app\n`,
  empty: HEAD,
  emptyNeg: HEAD.replace('TOC Entries: 12', 'TOC Entries: -3'),
  shards: `${TOC_CLAIMS}218; 1259 16410 TABLE smdb_data shard_claims app\n219; 1259 16420 TABLE smdb_data claim_clock app\n3362; 0 16410 TABLE DATA smdb_data shard_claims app\n3363; 0 16420 TABLE DATA smdb_data claim_clock app\n`,
  shardsNoClock: `${TOC_CLAIMS}218; 1259 16410 TABLE smdb_data shard_claims app\n3362; 0 16410 TABLE DATA smdb_data shard_claims app\n`,
  clockOnly: `${TOC_CLAIMS}219; 1259 16420 TABLE smdb_data claim_clock app\n3363; 0 16420 TABLE DATA smdb_data claim_clock app\n`,
};

export function withRestoreFakes<F extends ExecFileFake>(fake: F): F {
  return ((cmd: string, args: string[], optsOrCb: unknown, maybeCb?: unknown) => {
    const cb = (typeof optsOrCb === 'function' ? optsOrCb : maybeCb) as Cb;
    const sql = args.join(' ');
    const fail = (text: string) => cb(Object.assign(new Error(text), { code: 1 }), '', claimDb.failText ?? `ERROR:  ${text}`);
    if (cmd === 'docker' && args[0] === 'exec') {
      if (sql.includes('NOLOGIN REPLICATION')) {
        claimDb.recreateArgs = [...args];
        if (claimDb.fail === 'ensure') return fail('permission denied to create role');
      }
      if (sql.includes('DROP DATABASE')) { claimDb.dropSeen = true; claimDb.onDrop?.(); }
      if (sql.includes('rolcanlogin')) claimDb.loginReads++;
      if (sql.includes('rolcanlogin')) return claimDb.fail === 'login' ? fail('connection to server on socket failed') : cb(null, `${claimDb.login}\n`, '');
      if (sql.includes("to_regclass('smdb_data.claim_seq')")) {
        if (claimDb.fail === 'tables' && !claimDb.dropSeen) return fail('connection reset by peer');
        if (claimDb.fail === 'restored' && claimDb.dropSeen) return fail('connection reset by peer');
        return cb(null, `${claimDb.dropSeen ? claimDb.restoredTables : claimDb.tables}\n`, '');
      }
      if (sql.includes('SELECT coalesce(GREATEST(')) return claimDb.fail === 'floor' ? fail('connection reset by peer') : cb(null, `${claimDb.floor}\n`, '');
      if (sql.includes('FROM smdb_manager.generation), \'0||\')') && !sql.includes('INSERT INTO')) {
        claimDb.genEvents.push(claimDb.dropSeen ? 'gen-restored' : 'gen-live');
        if (claimDb.fail === 'gen' && !claimDb.dropSeen) return fail('connection reset by peer');
        const row = claimDb.dropSeen ? claimDb.restoredGeneration : claimDb.generation;
        return row ? cb(null, `${genLine(row)}\n`, '') : cb(Object.assign(new Error(NO_GEN), { code: 1 }), '', NO_GEN);
      }
      if (sql.includes("json_build_object('host', host") && sql.includes('FROM smdb_manager.addresses a WHERE slot IS NOT NULL')) {
        claimDb.genEvents.push('own-copies');
        return claimDb.fail === 'owncopies' ? fail('connection reset by peer') : cb(null, `${claimDb.ownCopies}\n`, '');
      }
      if (sql.includes('INSERT INTO smdb_manager.restore_state')) {
        claimDb.genEvents.push('state-upsert');
        if (claimDb.fail === 'state') return fail('could not write to file');
        const m = /now\(\), (\d+), '([^']*)', (?:'([^']*)'::timestamptz|NULL)/.exec(sql);
        const g = m ? Number(m[1]) : 0;
        const prior = claimDb.restoreState;
        const higher = !prior || g > prior.generation;
        claimDb.restoreState = { pending: true, file: (/VALUES \(true, true, '([^']*)'/.exec(sql) ?? [])[1] ?? '', generation: higher ? g : prior!.generation, machine: higher ? (m?.[2] ?? '') : prior!.machine, since: higher ? (m?.[3] ?? null) : prior!.since };
        return cb(null, `${claimDb.restoreState.generation}|${claimDb.restoreState.machine}|${claimDb.restoreState.since ?? ''}\n`, '');
      }
      if (sql.includes('DELETE FROM smdb_manager.receive_mark')) {
        claimDb.genEvents.push('mark-clear');
        claimDb.markClears.push(sql);
        return claimDb.fail === 'markclear' ? fail('connection reset by peer') : cb(null, '', '');
      }
      if (sql.includes('UPDATE smdb_manager.restore_state SET pending = false')) {
        claimDb.genEvents.push('state-clear');
        if (claimDb.fail === 'clear') return fail('connection reset by peer');
        if (claimDb.restoreState) claimDb.restoreState.pending = false;
        return cb(null, '', '');
      }
      if (sql.includes('INSERT INTO smdb_manager.generation')) {
        claimDb.genEvents.push('gen-write');
        claimDb.genWrites.push(sql);
        if (claimDb.fail === 'genwrite') return fail('cannot execute INSERT in a read-only transaction');
        return cb(null, '', '');
      }
      if (sql.includes('SET expires_up_ms = LEAST(') && !sql.includes('setval(')) {
        claimDb.onRaise?.();
        claimDb.capSql.push(sql);
        return claimDb.fail === 'cap' ? fail('permission denied for table shard_claims') : cb(null, claimDb.cap, '');
      }
      if (sql.includes("setval('smdb_data.claim_seq'")) {
        claimDb.onRaise?.();
        claimDb.raiseSql.push(sql);
        return claimDb.fail === 'raise' ? fail('permission denied for sequence claim_seq') : cb(null, claimDb.raise, '');
      }
    }
    return fake(cmd, args, optsOrCb, maybeCb);
  }) as F;
}

export const isTocRead = (args: string[]): boolean => args.includes('pg_restore') && args.includes('-l');

function tocChild(): any {
  claimDb.tocReads++;
  claimDb.onToc?.();
  const child: any = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.stdin.on('data', (d: Buffer) => { claimDb.tocInput += d.length; });
  child.kill = () => true;
  const failing = claimDb.fail === 'toc';
  setTimeout(() => {
    child.stdout.end(failing ? '' : TOC[claimDb.toc]);
    child.stderr.end(failing ? 'pg_restore: error: input file does not appear to be a valid archive' : '');
    setTimeout(() => child.emit('close', failing ? claimDb.tocCode : 0), 2);
  }, 2);
  return child;
}

export function withTocFake<F extends SpawnFake>(spawnFake: F): F {
  return ((cmd: string, args: string[], opts?: any) => (cmd === 'docker' && isTocRead(args) ? tocChild() : spawnFake(cmd, args, opts))) as F;
}
