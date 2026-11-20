import { Client } from '../client';
import { SHELL_RETURN, waitForEnter } from './shell';

export interface RouteInput extends NodeJS.ReadableStream {
  isRaw?: boolean;
  setRawMode?: (on: boolean) => unknown;
}

export interface RouteOutput {
  columns?: number;
  rows?: number;
  write(chunk: string | Uint8Array): unknown;
  on(event: 'resize', listener: () => void): unknown;
  off(event: 'resize', listener: () => void): unknown;
}

export interface RouteDeps {
  input?: RouteInput;
  output?: RouteOutput;
  /** How long the manager may take to say ready or refuse; 60 s when not given. */
  answerMs?: number;
}

// Longer than the manager's own worst case (the container list, the exec create and the exec start, 15 s each), so its reason arrives first.
const ANSWER_MS = 60000;

type Ending =
  | { kind: 'exit'; code: number | null; running: boolean }
  | { kind: 'silent' }
  | { kind: 'refused'; why: string }
  | { kind: 'lost' }
  | { kind: 'input-ended' };

/**
 * A shell in a bot container through the manager's console route, for a terminal with no docker of its own. The
 * manager runs the shell under a pseudo-terminal; this side puts its input in raw mode, relays keys and output, and
 * sends the size when the window changes. The result is the notice for the frame, if any.
 */
export async function runShellRoute(client: Pick<Client, 'openWs'>, botId: string, container: string, deps: RouteDeps = {}): Promise<string | undefined> {
  const input: RouteInput = deps.input ?? process.stdin;
  const output: RouteOutput = deps.output ?? process.stdout;
  const wasRaw = input.isRaw === true;
  const size = () => ({ cols: output.columns || 80, rows: output.rows || 24 });
  const answerMs = deps.answerMs ?? ANSWER_MS;

  let conn: { close: () => void; send: (msg: unknown) => boolean } | null = null;
  let opened = false;
  let ready = false;
  let over = false;
  const onKeys = (chunk: Buffer | string) => {
    conn?.send({ type: 'terminal:input', data: Buffer.from(chunk as never).toString('base64') });
  };
  const onResize = () => {
    if (ready) conn?.send({ type: 'terminal:resize', ...size() });
  };

  let finish: (e: Ending) => void = () => {};
  const onInputEnd = () => finish({ kind: 'input-ended' });

  const ending = await new Promise<Ending>((resolve) => {
    // Until ready no key is read, so without this bound a manager that never answers leaves no way out.
    const unanswered = setTimeout(() => finish({ kind: 'silent' }), answerMs);
    finish = (e) => {
      if (over) return;
      over = true;
      clearTimeout(unanswered);
      resolve(e);
    };
    const onMessage = (raw: { type: string }) => {
      if (over) return;
      const msg = raw as { type: string; data?: unknown; code?: unknown; running?: unknown; message?: unknown };
      if (msg.type === 'terminal:ready' && !ready) {
        ready = true;
        clearTimeout(unanswered);
        input.setRawMode?.(true);
        input.on('data', onKeys);
        input.once('end', onInputEnd);
        input.once('close', onInputEnd);
        input.resume();
      } else if (msg.type === 'terminal:data') {
        if (typeof msg.data === 'string') output.write(Buffer.from(msg.data, 'base64'));
      } else if (msg.type === 'terminal:exit') {
        finish({ kind: 'exit', code: typeof msg.code === 'number' ? msg.code : null, running: msg.running === true });
      } else if (msg.type === 'terminal:error') {
        finish({ kind: 'refused', why: typeof msg.message === 'string' && msg.message ? msg.message : 'the manager gave no reason' });
      }
    };
    output.on('resize', onResize);
    try {
      conn = client.openWs(
        onMessage,
        () => {
          opened = true;
          conn?.send({ type: 'terminal:start', botId, container, tty: true, ...size() });
        },
        (reason) => {
          if (ready) finish({ kind: 'lost' });
          else if (opened) finish({ kind: 'refused', why: `the connection to the manager closed before it answered (${reason})` });
          else finish({ kind: 'refused', why: `the connection to the manager did not open (${reason})` });
        },
      );
    } catch (err) {
      finish({ kind: 'refused', why: err instanceof Error ? err.message : String(err) });
    }
  });

  if (ending.kind === 'input-ended' || ending.kind === 'silent') (conn as { send: (msg: unknown) => boolean } | null)?.send({ type: 'terminal:stop' });
  input.off('data', onKeys);
  input.off('end', onInputEnd);
  input.off('close', onInputEnd);
  output.off('resize', onResize);
  if (ready) input.setRawMode?.(wasRaw);
  input.pause();
  (conn as { close: () => void } | null)?.close();

  if (ending.kind === 'refused') return `Could not open a shell in ${container}: ${ending.why}`;
  if (ending.kind === 'silent') {
    return `Could not open a shell in ${container}: the manager did not answer within ${answerMs / 1000} s; can't confirm whether a shell was opened`;
  }
  if (ending.kind === 'input-ended') {
    return `This terminal's input ended while the shell in ${container} was open, so its connection was closed; can't confirm whether a program started in it still runs.`;
  }
  if (ending.kind === 'exit' && ending.code === 0) return undefined;
  // What the shell printed last stays readable until Enter, as after docker exec.
  output.write(`\n${SHELL_RETURN}\n`);
  await waitForEnter(input);
  if (ending.kind === 'lost') {
    return `The connection to the manager closed while the shell in ${container} was open; can't confirm whether a program started in it still runs.`;
  }
  if (ending.running) return `The connection to the shell in ${container} closed; the Docker daemon reports the shell still running.`;
  if (ending.code === null) return `The shell in ${container} ended; can't confirm its exit code.`;
  return `The shell in ${container} ended with exit code ${ending.code}.`;
}
