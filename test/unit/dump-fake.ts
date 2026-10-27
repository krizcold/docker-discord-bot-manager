// The dump's snapshot holder: a `docker exec -i <db> psql` that exports a snapshot and prints the table counts. A
// spawn fake written before the holder existed is wrapped with withDumpHolder, which answers the holder the way a
// database that takes the snapshot answers it and passes every other spawn (pg_dump, pg_restore) to the fake.
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';

type SpawnFake = (cmd: string, args: string[], opts?: any) => any;

export interface HolderState {
  /** The table counts the holder prints, by "schema"."table". */
  counts: Record<string, number>;
  inRecovery: 't' | 'f';
  dbBytes: number;
  /** dataAt in epoch ms, -1 for none. */
  dataAt: number;
  /** One stderr text per holder spawn that fails before its counts; an empty queue answers normally. */
  failQueue: string[];
  /** A spawn error (the docker CLI missing) for the next holder. */
  spawnError: string | null;
  /** The holder prints nothing until it is killed. */
  hang: boolean;
  /** The holder does not exit when its stdin ends. */
  linger: boolean;
  spawned: string[][];
  stdin: string[];
  killed: number;
}

export function freshHolder(): HolderState {
  return { counts: { '"public"."t"': 3 }, inRecovery: 'f', dbBytes: 1000, dataAt: -1, failQueue: [], spawnError: null, hang: false, linger: false, spawned: [], stdin: [], killed: 0 };
}

export const holder: HolderState = ((globalThis as { __dumpHolder?: HolderState }).__dumpHolder ??= freshHolder());

export function resetHolder(): void {
  Object.assign(holder, freshHolder());
}

export const isHolder = (args: string[]): boolean => args[0] === 'exec' && args.includes('-i') && args.includes('psql') && args.includes('-X') && args.includes('-q');

function holderChild(args: string[]): any {
  holder.spawned.push(args);
  const child: any = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  let text = '';
  let closed = false;
  const close = (code: number | null) => {
    if (closed) return;
    closed = true;
    child.stdout.end();
    child.stderr.end();
    setTimeout(() => child.emit('close', code), 1);
  };
  child.kill = () => { holder.killed++; close(null); return true; };
  child.stdin.on('data', (d: Buffer) => { text += d.toString(); });
  child.stdin.on('finish', () => {
    holder.stdin.push(text);
    if (!holder.linger) close(0);
  });
  const spawnError = holder.spawnError;
  holder.spawnError = null;
  const failure = holder.failQueue.shift();
  setTimeout(() => {
    if (spawnError) { child.emit('error', new Error(spawnError)); return; }
    if (failure !== undefined) {
      child.stderr.write(`${failure}\n`);
      close(3);
      return;
    }
    if (holder.hang) return;
    child.stdout.write(`snap|00000003-0000001B-1|${holder.inRecovery}|${holder.dbBytes}|${holder.dataAt}\n`);
    for (const [name, n] of Object.entries(holder.counts)) child.stdout.write(`count|${name}|${n}\n`);
    child.stdout.write('end|\n');
  }, 1);
  return child;
}

export function withDumpHolder<F extends SpawnFake>(spawnFake: F): F {
  return ((cmd: string, args: string[], opts?: any) => (cmd === 'docker' && isHolder(args) ? holderChild(args) : spawnFake(cmd, args, opts))) as F;
}
