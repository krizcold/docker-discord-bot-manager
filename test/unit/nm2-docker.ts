// A fake docker CLI for the NM2 rows: the database containers, the dump and its snapshot holder, and the throwaway
// test-restore container. State lives on globalThis so the vi.mock factory and the test share it.
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import { withFence } from './fence-fake';
import { resetHolder, withDumpHolder } from './dump-fake';

type Cb = (err: Error | null, stdout: string, stderr: string) => void;
export type Answer = { ok: boolean; stdout?: string; stderr?: string; hang?: boolean };

export interface DockerState {
  calls: string[][];
  /** Container name -> running; null: docker cannot say. Absent: running. */
  running: Record<string, boolean | null>;
  /** One answer per pg_dump spawn; an empty queue dumps. */
  dumps: Array<{ code: number; stderr?: string }>;
  dumpHold: Promise<void> | null;
  dumpHang: boolean;
  /** Answers by a test of the argv, checked before every built-in answer. */
  overrides: Array<{ match: (args: string[]) => boolean; answer: Answer | (() => Answer) }>;
  restore: { code: number; stderr?: string; hang?: boolean };
  restoreStdin: number;
  /** The counts the throwaway answers after the restore. */
  restoredCounts: Record<string, number> | null;
  ready: boolean;
  dfFreeKb: number;
  orphans: { containers: string[]; volumes: string[] };
}

function fresh(): DockerState {
  return {
    calls: [], running: {}, dumps: [], dumpHold: null, dumpHang: false, overrides: [],
    restore: { code: 0 }, restoreStdin: 0, restoredCounts: null, ready: true, dfFreeKb: 50 * 1024 * 1024, orphans: { containers: [], volumes: [] },
  };
}

export const docker: DockerState = ((globalThis as { __nm2Docker?: DockerState }).__nm2Docker ??= fresh());

export function resetDocker(): void {
  Object.assign(docker, fresh());
  resetHolder();
}

export const callsWith = (word: string): string[][] => docker.calls.filter(a => a.join(' ').includes(word));

const countsText = (counts: Record<string, number>) => Object.entries(counts).map(([k, v]) => `count|${k}|${v}`).join('\n') + '\n';

function execFileFake(_cmd: string, args: string[], optsOrCb: unknown, maybeCb?: unknown): any {
  const cb = (typeof optsOrCb === 'function' ? optsOrCb : maybeCb) as Cb;
  docker.calls.push(args);
  const answer = (a: Answer) => a.hang ? undefined : setTimeout(() => (a.ok ? cb(null, a.stdout ?? '', a.stderr ?? '') : cb(Object.assign(new Error(a.stderr || 'failed'), { code: 1 }), a.stdout ?? '', a.stderr ?? 'failed')), 1);
  const over = docker.overrides.find(o => o.match(args));
  if (over) return answer(typeof over.answer === 'function' ? over.answer() : over.answer);
  const line = args.join(' ');
  if (args[0] === 'inspect') {
    const name = String(args[args.length - 1]);
    const state = docker.running[name];
    if (state === null) return answer({ ok: false, stderr: 'Cannot connect to the Docker daemon' });
    return answer({ ok: true, stdout: state === false ? 'false\n' : 'true\n' });
  }
  if (args[0] === 'ps' && line.includes('smdb.testrestore')) return answer({ ok: true, stdout: docker.orphans.containers.map(n => `${n}\n`).join('') });
  if (args[0] === 'volume' && args[1] === 'ls') return answer({ ok: true, stdout: docker.orphans.volumes.map(n => `${n}\n`).join('') });
  if (args[0] === 'exec' && args.includes('pg_isready')) return answer(docker.ready ? { ok: true } : { ok: false, stderr: '127.0.0.1:5432 - no response' });
  if (args[0] === 'exec' && args.includes('df')) {
    return answer({ ok: true, stdout: `Filesystem 1024-blocks Used Available Capacity Mounted on\noverlay 100000000 10 ${docker.dfFreeKb} 1% /var/lib/postgresql/data\n` });
  }
  if (args[0] === 'exec' && String(args[1]).startsWith('smdb-testrestore-') && args.includes('psql')) {
    return answer({ ok: true, stdout: countsText(docker.restoredCounts ?? {}) });
  }
  if (args[0] === 'exec' && line.includes('SHOW default_transaction_read_only')) return answer({ ok: true, stdout: 'off\n' });
  return answer({ ok: true });
}

function spawnFake(cmd: string, args: string[]): any {
  docker.calls.push(args);
  const child: any = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  let closed = false;
  const close = (code: number | null, out = '', err = '') => {
    if (closed) return;
    closed = true;
    child.stdout.end(out);
    child.stderr.end(err);
    setTimeout(() => child.emit('close', code), 2);
  };
  child.kill = () => { close(null); return true; };
  if (cmd !== 'docker') return child;
  if (args.includes('pg_restore')) {
    child.stdin.on('data', (d: Buffer) => { docker.restoreStdin += d.length; });
    child.stdin.on('finish', () => {
      if (docker.restore.hang) return;
      close(docker.restore.code, '', docker.restore.stderr ?? '');
    });
    return child;
  }
  if (args.includes('pg_dump')) {
    const answer = docker.dumps.shift() ?? { code: 0 };
    if (docker.dumpHang) return child;
    Promise.resolve(docker.dumpHold).then(() => setTimeout(() => close(answer.code, answer.code === 0 ? 'dump-bytes' : '', answer.stderr ?? ''), 2));
    return child;
  }
  setTimeout(() => close(0), 2);
  return child;
}

export async function childProcessMock(real: typeof import('child_process')): Promise<Record<string, unknown>> {
  const execFile = withFence(execFileFake as any);
  const spawn = withDumpHolder(spawnFake as any);
  return { ...real, execFile, spawn, default: { ...real, execFile, spawn } };
}
