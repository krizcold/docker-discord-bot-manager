// The NM31 run fakes: docker through child_process (nm2-docker's execFile and spawn, a psql spawn answered by
// `run.psql`, and an exec that answers compose up, pg_isready and rm -f), a renameSync hook, and dockerClient's
// volumeState. docker container inspect (execFileSync) answers the data mount the deployed compose names. State lives
// on globalThis so the vi.mock factories and the test share it. No src import here: the factories load this file
// before the modules they mock.
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import YAML from 'yaml';
import { docker } from './nm2-docker';
import { isHolder } from './dump-fake';

export type PsqlCall = { login: string; db: string; input: string; args: string[] };
export type PsqlAnswer = { code: number; stdout?: string; stderr?: string };
export type ExecAnswer = { ok: boolean; stdout?: string; stderr?: string; hang?: boolean };
/** One answer of docker container inspect: its output, docker's error text, or no answer within the call's limit. */
export type MountAnswer = { out: string } | { stderr: string } | { timeout: true };

export interface RunState {
  volumes: Record<string, 'exists' | 'absent' | 'unknown'>;
  psql: null | ((c: PsqlCall) => PsqlAnswer | Promise<PsqlAnswer>);
  psqlCalls: PsqlCall[];
  /** Every exec command line, in order (also pushed to docker.calls as ['sh', command]). */
  execCalls: string[];
  /** Answers by a test of the command, checked before the built-in answers; a function answer runs at the call. */
  execOverrides: Array<{ match: (command: string) => boolean; answer: ExecAnswer | (() => ExecAnswer | Promise<ExecAnswer>) }>;
  /** Runs before each renameSync with its paths; a throw is the rename's error. */
  beforeRename: null | ((from: string, to: string) => void);
  /** Runs after each renameSync that succeeded. */
  afterRename: null | ((from: string, to: string) => void);
  /** The dump's snapshot holder (a psql spawn) goes to nm2-docker's holder fake instead of `psql`. */
  holderToBase: boolean;
  /** Runs before each rmSync with its path; a throw is the removal's error. */
  beforeRm: null | ((target: string) => void);
  /** When a list: lstatSync answers uid 0 (a file the root manager delivered) and chownSync and lchownSync record their path here instead of acting. */
  rootOwned: null | string[];
  /** Set by every compose up command (with or without --no-start), cleared by the next mount read. */
  upRead: boolean;
  /** The -f file of the last compose up command. */
  upFile: string | null;
  /** Mount reads by container name; a list gives one answer per read (null: the default) and the default once it is used up. */
  mounts: Record<string, MountAnswer | Array<MountAnswer | null>>;
}

function fresh(): RunState {
  return {
    volumes: {}, psql: null, psqlCalls: [], execCalls: [], execOverrides: [], beforeRename: null, afterRename: null, holderToBase: false, beforeRm: null, rootOwned: null,
    upRead: false, upFile: null, mounts: {},
  };
}

export const run: RunState = ((globalThis as { __nm31Run?: RunState }).__nm31Run ??= fresh());

export function resetRun(): void {
  Object.assign(run, fresh());
}

const unquote = (s: string) => s.replace(/^"|"$/g, '');

const DATA_MOUNT = '/var/lib/postgresql/data';
type Files = { read: null | ((file: string) => string) };
const files: Files = ((globalThis as { __nm31Files?: Files }).__nm31Files ??= { read: null });

/** What docker shows at the data folder of container c, made from the compose of the last up: the volume its service names. */
function composeMount(c: string): MountAnswer {
  const gone = { stderr: `Error: No such container: ${c}` };
  if (!run.upFile || !files.read) return gone;
  let compose: any;
  try { compose = YAML.parse(files.read(run.upFile)); } catch { return gone; }
  const svc = Object.values((compose?.services ?? {}) as Record<string, any>).find(s => s?.container_name === c);
  if (!svc) return gone;
  const entry = ((svc.volumes ?? []) as any[]).find(v => (typeof v === 'string' ? v.split(':')[1] : v?.target) === DATA_MOUNT);
  if (!entry) return { out: '' };
  const source = String(typeof entry === 'string' ? entry.split(':')[0] : entry.source);
  if (typeof entry === 'string' ? /^[./]/.test(source) : entry.type === 'bind') return { out: `bind ${source}\n` };
  return { out: `volume ${compose?.volumes?.[source]?.name ?? source}\n` };
}

/** docker container inspect of a container's mounts, as execFileSync answers or throws it. */
export function mountRead(args: string[]): string {
  docker.calls.push(args);
  run.upRead = false;
  const c = String(args[args.length - 1]);
  const set = run.mounts[c];
  const a = (Array.isArray(set) ? set.shift() : set) ?? composeMount(c);
  if ('timeout' in a) throw Object.assign(new Error('spawnSync docker ETIMEDOUT'), { code: 'ETIMEDOUT', stderr: '' });
  if ('stderr' in a) throw Object.assign(new Error(`Command failed: docker ${args.join(' ')}\n${a.stderr}`), { status: 1, stderr: Buffer.from(`${a.stderr}\n`), stdout: Buffer.from('') });
  return a.out;
}

/** The built-in exec answers: compose up makes the service's container and, without --no-start, starts it; pg_isready answers for a running one; rm -f removes. */
function builtIn(command: string, fsReal: typeof import('fs')): ExecAnswer {
  const up = /^docker compose -f "([^"]+)" -p "[^"]+" up (-d|--no-start) ([A-Za-z0-9._-]+)$/.exec(command);
  if (up) {
    const text = fsReal.readFileSync(up[1], 'utf-8');
    const block = text.split(/\n(?=  \S)/).find(b => b.startsWith(`  ${up[3]}:`));
    const name = block ? /container_name: (\S+)/.exec(block)?.[1] : undefined;
    if (!name) return { ok: false, stderr: `no such service: ${up[3]}` };
    if (up[2] === '-d') docker.running[name] = true;
    return { ok: true };
  }
  const ready = /^docker exec "([^"]+)" pg_isready /.exec(command);
  if (ready) return docker.running[ready[1]] === false ? { ok: false, stderr: '127.0.0.1:5432 - no response' } : { ok: true };
  const rm = /^docker rm -f ("[^"]+"|\S+)$/.exec(command);
  if (rm) {
    docker.running[unquote(rm[1])] = false;
    return { ok: true };
  }
  return { ok: false, stderr: `the fake docker does not run: ${command}` };
}

export async function childProcessMock(real: typeof import('child_process'), fsReal: typeof import('fs')): Promise<Record<string, unknown>> {
  const fake = await import('./nm2-docker');
  const base = await fake.childProcessMock(real) as { spawn: (...a: unknown[]) => unknown; execFile: unknown };
  files.read = file => fsReal.readFileSync(file, 'utf-8');
  const spawn = (cmd: string, args: string[], opts?: unknown) => {
    if (cmd !== 'docker' || !args.includes('psql') || (run.holderToBase && isHolder(args))) return base.spawn(cmd, args, opts);
    docker.calls.push(args);
    const child: any = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.kill = () => true;
    let input = '';
    child.stdin.on('data', (d: Buffer) => { input += String(d); });
    child.stdin.on('finish', async () => {
      const u = args.indexOf('-U');
      const d = args.indexOf('-d');
      const call = { login: args[u + 1], db: args[d + 1], input, args };
      run.psqlCalls.push(call);
      const a = run.psql ? await run.psql(call) : { code: 1, stderr: 'no psql answer set' };
      child.stdout.end(a.stdout ?? '');
      child.stderr.end(a.stderr ?? '');
      setTimeout(() => child.emit('close', a.code), 1);
    });
    return child;
  };
  const exec = (command: string, optsOrCb: unknown, maybeCb?: unknown) => {
    const cb = (typeof optsOrCb === 'function' ? optsOrCb : maybeCb) as ((err: Error | null, out: string, errOut: string) => void) | undefined;
    run.execCalls.push(command);
    docker.calls.push(['sh', command]);
    const up = /^docker compose -f "([^"]+)" -p "[^"]+" up (?:-d|--no-start) /.exec(command);
    if (up) {
      run.upRead = true;
      run.upFile = up[1];
    }
    const child = new EventEmitter();
    void (async () => {
      const over = run.execOverrides.find(o => o.match(command));
      const a = over ? (typeof over.answer === 'function' ? await over.answer() : over.answer) : builtIn(command, fsReal);
      if (a.hang) return;
      setTimeout(() => (a.ok ? cb?.(null, a.stdout ?? '', a.stderr ?? '') : cb?.(Object.assign(new Error(a.stderr || 'failed'), { code: 1, stderr: a.stderr ?? '' }), a.stdout ?? '', a.stderr ?? '')), 1);
    })();
    return child;
  };
  const execFileSync = (cmd: string, args: string[], opts?: unknown): unknown => {
    if (cmd !== 'docker') return (real.execFileSync as any)(cmd, args, opts);
    if (args[0] === 'container' && args[1] === 'inspect') return mountRead(args);
    throw new Error(`the fake docker does not run: docker ${args.join(' ')}`);
  };
  const wrap = { execFile: base.execFile, spawn, exec, execFileSync };
  return { ...real, ...wrap, default: { ...real, ...wrap } };
}

export function fsMock(real: typeof import('fs')): Record<string, unknown> {
  const renameSync = (from: import('fs').PathLike, to: import('fs').PathLike) => {
    run.beforeRename?.(String(from), String(to));
    real.renameSync(from, to);
    run.afterRename?.(String(from), String(to));
  };
  const rmSync = (target: import('fs').PathLike, opts?: import('fs').RmOptions) => {
    run.beforeRm?.(String(target));
    real.rmSync(target, opts);
  };
  const lstatSync = ((p: import('fs').PathLike, o?: import('fs').StatSyncOptions) => {
    const st = real.lstatSync(p, o as any);
    if (run.rootOwned && st) (st as { uid: number }).uid = 0;
    return st;
  }) as typeof real.lstatSync;
  const chown = (realFn: typeof real.chownSync) => (p: import('fs').PathLike, uid: number, gid: number) => {
    if (run.rootOwned) run.rootOwned.push(String(p));
    else realFn(p, uid, gid);
  };
  const chownSync = chown(real.chownSync);
  const lchownSync = chown(real.lchownSync);
  const wrap = { renameSync, rmSync, lstatSync, chownSync, lchownSync };
  return { ...real, ...wrap, default: { ...real, ...wrap } };
}

/** The stop of a container by name sets it stopped, as docker stop does. */
export function stopsStop(): void {
  let name = '';
  docker.overrides.push({
    match: (a) => {
      if (a[0] !== 'stop') return false;
      name = String(a[a.length - 1]);
      return true;
    },
    answer: () => {
      docker.running[name] = false;
      return { ok: true };
    },
  });
}
