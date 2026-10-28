// The restore's claim floor and maintenance guard, answered the way a database on contract 8's schema answers them, for
// fake docker CLIs written before the restore read the bot's login, its claim numbers and the dump's table of contents.
// withRestoreFakes wraps an execFile fake and withTocFake a spawn fake; every other call passes to the wrapped fake.
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';

type Cb = (err: Error | null, stdout: string, stderr: string) => void;
type ExecFileFake = (cmd: string, args: string[], optsOrCb: unknown, maybeCb?: unknown) => unknown;
type SpawnFake = (cmd: string, args: string[], opts?: any) => any;

export type TocShape = 'claims' | 'terms' | 'none';

export interface ClaimDb {
  /** readBotLogin's answer: recovery|canlogin|sessions. */
  login: string;
  /** The claim tables probe before the drop: claim_seq|guild_ownership|claim column. */
  tables: string;
  /** The claim floor probe's answer. */
  floor: string;
  /** The raise statement's answer. */
  raise: string;
  /** The claim tables probe after the drop. */
  restoredTables: string;
  toc: TocShape;
  fail: null | 'login' | 'tables' | 'floor' | 'raise' | 'toc' | 'restored';
  /** The stderr a failing claim call answers; null for a fixed ERROR line. */
  failText: string | null;
  /** The TOC read's exit code when fail is 'toc'. */
  tocCode: number;
  dropSeen: boolean;
  raiseSql: string[];
  tocReads: number;
  tocInput: number;
  loginReads: number;
  onRaise: (() => void) | null;
  onToc: (() => void) | null;
}

export function freshClaimDb(): ClaimDb {
  return {
    login: 'false|false|0', tables: 't|t|t', floor: '7', raise: 'seq|8\nguild|g1\nguild|g2\n', restoredTables: 't|t|t', toc: 'claims',
    fail: null, failText: null, tocCode: 1, dropSeen: false, raiseSql: [], tocReads: 0, tocInput: 0, loginReads: 0, onRaise: null, onToc: null,
  };
}

export const claimDb: ClaimDb = ((globalThis as { __claimDb?: ClaimDb }).__claimDb ??= freshClaimDb());

export function resetClaimDb(over: Partial<ClaimDb> = {}): void {
  Object.assign(claimDb, freshClaimDb(), over);
}

/** The settled Maintenance a restore admits, and the settled Off. */
export const MAINTAINED = { maintenance: { state: 'maintenance', message: '', orderedAt: '2026-10-28T00:00:00.000Z', settled: true, hook: 'confirmed', login: 'blocked', savedByBot: 'maintenance' } };
export const OFF = { maintenance: { state: 'off', message: '', orderedAt: '2026-10-28T00:00:00.000Z', settled: true, hook: 'confirmed', login: 'blocked', savedByBot: 'maintenance' } };

const HEAD = ';\n; Archive created at 2026-10-28 10:00:00 UTC\n;     dbname: app\n;     TOC Entries: 12\n;     Compression: gzip\n;     Dump Version: 1.15-0\n;     Format: CUSTOM\n;     Integer: 4 bytes\n;     Offset: 8 bytes\n;     Dumped from database version: 16.4\n;     Dumped by pg_dump version: 16.4\n;\n;\n; Selected TOC Entries:\n;\n';

/** pg_restore -l of PostgreSQL 16 for a dump on contract 8's schema, on the term schema, and with neither table. */
export const TOC: Record<TocShape, string> = {
  claims: `${HEAD}5; 2615 16385 SCHEMA - smdb_data app\n216; 1259 16386 TABLE smdb_data guild_ownership app\n217; 1259 16392 SEQUENCE smdb_data claim_seq app\n215; 1259 16400 TABLE smdb_data meta app\n3360; 0 16386 TABLE DATA smdb_data guild_ownership app\n3361; 0 16400 TABLE DATA smdb_data meta app\n3367; 0 0 SEQUENCE SET smdb_data claim_seq app\n3200; 2606 16391 CONSTRAINT smdb_data guild_ownership guild_ownership_pkey app\n`,
  terms: `${HEAD}5; 2615 16385 SCHEMA - smdb_data app\n216; 1259 16386 TABLE smdb_data guild_ownership app\n215; 1259 16400 TABLE smdb_data meta app\n3360; 0 16386 TABLE DATA smdb_data guild_ownership app\n3361; 0 16400 TABLE DATA smdb_data meta app\n3200; 2606 16391 CONSTRAINT smdb_data guild_ownership guild_ownership_pkey app\n`,
  none: `${HEAD}5; 2615 16385 SCHEMA - public app\n215; 1259 16400 TABLE public t app\n3361; 0 16400 TABLE DATA public t app\n`,
};

export function withRestoreFakes<F extends ExecFileFake>(fake: F): F {
  return ((cmd: string, args: string[], optsOrCb: unknown, maybeCb?: unknown) => {
    const cb = (typeof optsOrCb === 'function' ? optsOrCb : maybeCb) as Cb;
    const sql = args.join(' ');
    const fail = (text: string) => cb(Object.assign(new Error(text), { code: 1 }), '', claimDb.failText ?? `ERROR:  ${text}`);
    if (cmd === 'docker' && args[0] === 'exec') {
      if (sql.includes('DROP DATABASE')) claimDb.dropSeen = true;
      if (sql.includes('rolcanlogin')) claimDb.loginReads++;
      if (sql.includes('rolcanlogin')) return claimDb.fail === 'login' ? fail('connection to server on socket failed') : cb(null, `${claimDb.login}\n`, '');
      if (sql.includes("to_regclass('smdb_data.claim_seq')")) {
        if (claimDb.fail === 'tables' && !claimDb.dropSeen) return fail('connection reset by peer');
        if (claimDb.fail === 'restored' && claimDb.dropSeen) return fail('connection reset by peer');
        return cb(null, `${claimDb.dropSeen ? claimDb.restoredTables : claimDb.tables}\n`, '');
      }
      if (sql.includes('SELECT coalesce(GREATEST(')) return claimDb.fail === 'floor' ? fail('connection reset by peer') : cb(null, `${claimDb.floor}\n`, '');
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
