import { ChildProcess, spawn as nodeSpawn, SpawnOptions } from 'child_process';
import { Container } from './api';
import { wrap } from './install';

// The page's console wrapper (terminal.ts:1298 to :1303) without its stty line: the real TTY carries the size.
export const SHELL_WRAP = 'if command -v bash >/dev/null 2>&1; then exec bash; else exec sh; fi';

export const SHELL_RETURN = 'Press Enter to return to Bot Manager.';
export const NO_DOCKER = 'The docker command is not available where this terminal runs, so it cannot open a shell in a bot container.';

export interface ShellCommand {
  program: string;
  args: string[];
}

// DBM_TUI_CHECK_DOCKER, a JSON list of program and arguments, names a stand-in for docker in the checks only.
export function dockerProgram(env: NodeJS.ProcessEnv = process.env): ShellCommand {
  const raw = env.DBM_TUI_CHECK_DOCKER;
  if (raw) {
    let list: unknown;
    try {
      list = JSON.parse(raw);
    } catch {
      list = null;
    }
    if (Array.isArray(list) && list.length > 0 && list.every((x) => typeof x === 'string')) {
      return { program: list[0] as string, args: list.slice(1) as string[] };
    }
    throw new Error('DBM_TUI_CHECK_DOCKER must be a JSON list of strings');
  }
  return { program: 'docker', args: [] };
}

export function shellCommand(container: string, env: NodeJS.ProcessEnv = process.env): ShellCommand {
  const docker = dockerProgram(env);
  return { program: docker.program, args: [...docker.args, 'exec', '-it', container, '/bin/sh', '-c', SHELL_WRAP] };
}

export function shellBanner(container: string, columns: number): string {
  const width = Math.max(columns - 1, 20);
  const lines = [
    `Shell in ${container}.`,
    'Changes to files outside mounted volumes are lost on rebuild.',
    'Type exit to return to Bot Manager.',
  ].flatMap((l) => wrap(l, width));
  return lines.join('\n') + '\n\n';
}

/** The running containers of a containers answer, by the page's rule (index.html:5366). */
export function runningContainers(list: Container[]): Container[] {
  return list.filter((c) => !!c && typeof c.name === 'string' && c.name !== '' && /run/i.test(String(c.state ?? '')));
}

/** Resolves once a line ends on the input, or the input ends. */
export function waitForEnter(input: NodeJS.ReadableStream): Promise<void> {
  return new Promise<void>((resolve) => {
    const done = () => {
      input.off('data', onData);
      input.off('end', done);
      input.off('close', done);
      input.pause();
      resolve();
    };
    const onData = (chunk: Buffer | string) => {
      if (/[\r\n]/.test(chunk.toString())) done();
    };
    input.on('data', onData);
    input.once('end', done);
    input.once('close', done);
    input.resume();
  });
}

export interface ShellDeps {
  env?: NodeJS.ProcessEnv;
  spawn?: (program: string, args: string[], options: SpawnOptions) => ChildProcess;
  input?: NodeJS.ReadableStream;
  write?: (text: string) => void;
}

/**
 * Runs docker exec with the terminal's own stdio. Exit 0 returns at once; any other end waits for Enter, so what
 * docker or the shell printed last stays readable. The result is the notice for the frame, if any.
 */
export async function runShell(container: string, deps: ShellDeps = {}): Promise<string | undefined> {
  const write = deps.write ?? ((t: string) => void process.stdout.write(t));
  let command: ShellCommand;
  try {
    command = shellCommand(container, deps.env ?? process.env);
  } catch (err) {
    return `Could not open a shell in ${container}: ${err instanceof Error ? err.message : String(err)}`;
  }
  const spawn = deps.spawn ?? nodeSpawn;
  const end = await new Promise<{ code: number | null; signal: NodeJS.Signals | null } | { error: NodeJS.ErrnoException }>((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(command.program, command.args, { stdio: 'inherit' });
    } catch (error) {
      resolve({ error: error as NodeJS.ErrnoException });
      return;
    }
    child.once('error', (error: NodeJS.ErrnoException) => resolve({ error }));
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  if ('error' in end) {
    if (end.error.code === 'ENOENT') return NO_DOCKER;
    return `Could not start ${command.program}: ${end.error.message}`;
  }
  if (end.code === 0) return undefined;
  const how = end.code === null ? `was stopped (${end.signal ?? 'signal'})` : `ended with exit code ${end.code}`;
  write(`\n${SHELL_RETURN}\n`);
  await waitForEnter(deps.input ?? process.stdin);
  return `The shell in ${container} ${how}.`;
}
