// provisionRoles' reads as a set-up cluster answers them (NM20 part 3: Enable, the join code, the start and the
// maintenance check now provision first), for the docker fakes of rows that drive those callers. routed() also sends
// psql calls that execFile now makes (fleetReplication's statements go through dbLogin.runCall) to the file's spawn
// fake, which answered them when they went through spawn.
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';

export const SET_UP_ROLES_READ = 'false|false|false|true|false|true|ok|ok|ok|ok|ok|ok|4';

/** The answer of a set-up cluster to a provisioning or drift read, or null for any other SQL. */
export function rolesReadAnswer(text: string): string | null {
  if (text.includes('pg_catalog.pg_is_in_recovery()::text,')) return `${SET_UP_ROLES_READ}\n`;
  if (text.includes("'owner|'")) return 'owner|dbm_meta|ok\n';
  if (text.includes("'drift|'")) return 'drift|0|0|0\n';
  return null;
}

type ExecFile = (cmd: string, args: string[], opts: any, cb?: any) => any;
type Spawn = (cmd: string, args: string[], opts?: any) => any;

function answeredChild(out: string): any {
  const child: any = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.stdin.resume();
  child.kill = () => true;
  setTimeout(() => {
    child.stdout.end(out);
    child.stderr.end('');
    setTimeout(() => child.emit('close', 0), 1);
  }, 1);
  return child;
}

/** spawn that answers the reads itself. */
export function rolesSpawn(spawn: Spawn): Spawn {
  return (cmd, args, opts) => {
    const read = args.includes('psql') ? rolesReadAnswer(args.join(' ')) : null;
    return read !== null ? answeredChild(read) : spawn(cmd, args, opts);
  };
}

/** execFile that answers the reads itself and, with `psqlTo`, runs every other docker exec psql call not matching `keep` through that spawn fake. */
export function rolesExecFile(execFile: ExecFile, psqlTo?: Spawn, keep?: RegExp): ExecFile {
  return (cmd, args, opts, cb) => {
    const done = typeof opts === 'function' ? opts : cb;
    const read = args.includes('psql') ? rolesReadAnswer(args.join(' ')) : null;
    if (read !== null) {
      setImmediate(() => done(null, read, ''));
      return new EventEmitter();
    }
    if (!psqlTo || args[0] !== 'exec' || !args.includes('psql') || keep?.test(args.join(' '))) return execFile(cmd, args, opts, cb);
    const child = psqlTo(cmd, args);
    let out = '';
    let err = '';
    child.stdout?.on('data', (d: unknown) => { out += String(d); });
    child.stderr?.on('data', (d: unknown) => { err += String(d); });
    child.on('close', (code: number) => done(code ? Object.assign(new Error(err || 'exit 1'), { code }) : null, out, err));
    child.stdin?.end?.();
    return new EventEmitter();
  };
}
