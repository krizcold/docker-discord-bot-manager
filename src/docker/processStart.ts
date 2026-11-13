import { spawn, execFile } from 'child_process';
import type { ChildProcess, SpawnOptions, ExecFileOptions, ExecFileException } from 'child_process';

export type Started = { child: ChildProcess; error?: undefined; reason?: undefined } | { child?: undefined; error: string; reason: string };

function reasonOf(err: unknown): string {
  return (err as any)?.message || String(err);
}

/** Starts a process; Node 24 throws a fork fault (ENOMEM) synchronously, and that throw is answered as an error here. */
export function startProcess(cmd: string, args: readonly string[], opts?: SpawnOptions): Started {
  try {
    const child = opts === undefined ? spawn(cmd, args as string[]) : spawn(cmd, args as string[], opts);
    return { child };
  } catch (err) {
    const reason = reasonOf(err);
    return { error: `${cmd} could not start (${reason})`, reason };
  }
}

export type ExecFileCallback = (err: ExecFileException | null, stdout: string, stderr: string) => void;

/** execFile whose synchronous fork fault reaches the callback on the next tick. */
export function execFileGuarded(cmd: string, args: readonly string[], opts: ExecFileOptions & { encoding?: BufferEncoding }, callback: ExecFileCallback): void {
  try {
    (execFile as any)(cmd, args, opts, callback);
  } catch (err) {
    const e: ExecFileException = new Error(`${cmd} could not start (${reasonOf(err)})`);
    e.code = (err as any)?.code;
    process.nextTick(() => callback(e, '', ''));
  }
}
