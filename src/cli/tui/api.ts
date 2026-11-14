import { Client, CliResponse } from '../client';
import { waitForEvent, WaitTimeoutError } from '../waiter';

export interface Bot {
  id: string;
  displayName?: string;
  status?: string;
  sourceType?: string;
  activeOp?: string | null;
  fleetDb?: { replication?: unknown } | null;
  fleetDbReplica?: { copyCleared?: boolean } | null;
  fleetDbReplicaSeed?: { phase?: string } | null;
  dataPlace?: 'json' | 'outside' | null;
  fleetBackup?: { main?: BackupFamilyStatus | null; copy?: BackupFamilyStatus | null } | null;
  updateAvailable?: boolean;
  updateCantConfirm?: string;
  behindBy?: number;
}

export interface BackupFamilyStatus {
  lastAt?: number | null;
  listError?: string | null;
}

export type ActionKind = 'start' | 'stop' | 'restart' | 'build' | 'update';

export interface ActionResult {
  ok: boolean | null;
  text: string;
}

export interface Frame {
  event: string;
  data: unknown;
}

export interface Container {
  name: string;
  state: string;
  status: string;
}

const WAIT_MS = 120_000;
const BUILD_WAIT_MS = 30 * 60_000;

// The same routes, events and limits as the dbm verbs in commands.ts.
const LIFECYCLE: Record<Exclude<ActionKind, 'stop'>, { success: string; fail: string; waitMs: number }> = {
  start: { success: 'bot:started', fail: 'bot:start-failed', waitMs: WAIT_MS },
  restart: { success: 'bot:restarted', fail: 'bot:restart-failed', waitMs: WAIT_MS },
  build: { success: 'bot:built', fail: 'bot:build-failed', waitMs: BUILD_WAIT_MS },
  update: { success: 'bot:rebuilt', fail: 'bot:pull-failed', waitMs: BUILD_WAIT_MS },
};

export function botName(bot: Bot): string {
  return bot.displayName || bot.id;
}

function errorText(res: CliResponse): string {
  const b = res.body as { error?: unknown; message?: unknown } | null;
  if (b && typeof b === 'object') {
    if (typeof b.error === 'string' && b.error) return b.error;
    if (typeof b.message === 'string' && b.message) return b.message;
  }
  if (typeof res.body === 'string' && res.body.trim()) return res.body.trim();
  return `HTTP ${res.status}`;
}

function why(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function listBots(client: Client): Promise<Bot[]> {
  let res: CliResponse;
  try {
    res = await client.request('GET', '/api/bots');
  } catch (err) {
    throw new Error(why(err));
  }
  const body = res.body as { success?: boolean; bots?: unknown } | null;
  if (!res.ok || !body || typeof body !== 'object' || body.success === false) throw new Error(errorText(res));
  if (!Array.isArray(body.bots)) throw new Error('the answer held no bot list');
  return body.bots as Bot[];
}

const VERB: Record<ActionKind, string> = { start: 'start', stop: 'stop', restart: 'restart', build: 'build', update: 'update' };

function doneText(kind: ActionKind, name: string, warning?: unknown): string {
  const base = {
    start: `Started ${name}.`,
    stop: `Stopped ${name}.`,
    restart: `Restarted ${name}.`,
    build: `Built ${name}.`,
    update: `Updated ${name} from its source.`,
  }[kind];
  return typeof warning === 'string' && warning ? `${base} Warning: ${warning}` : base;
}

function unknownText(kind: ActionKind, name: string): string {
  return {
    start: `whether ${name} started`,
    stop: `whether ${name} stopped`,
    restart: `whether ${name} restarted`,
    build: `whether the build of ${name} finished`,
    update: `whether the update of ${name} finished`,
  }[kind];
}

export async function stopBot(client: Client, bot: Bot): Promise<ActionResult> {
  const name = botName(bot);
  let res: CliResponse;
  try {
    res = await client.request('POST', `/api/bots/${bot.id}/stop`);
  } catch (err) {
    return { ok: null, text: `can't confirm ${unknownText('stop', name)}: the manager did not answer (${why(err)}).` };
  }
  const b = res.body as { success?: boolean; warning?: unknown } | null;
  if (!res.ok || !b || b.success === false) return { ok: false, text: `Could not stop ${name}: ${errorText(res)}` };
  return { ok: true, text: doneText('stop', name, b.warning) };
}

/**
 * Start, restart, build or update, judged as `dbm bots <verb> --wait` judges it: the route's answer names an
 * operation id, and the outcome is that operation's success or failure event on /ws. onAccepted runs once the
 * manager has accepted the request.
 */
export async function lifecycleAction(
  client: Client,
  bot: Bot,
  kind: Exclude<ActionKind, 'stop'>,
  onAccepted?: (opId: string) => void,
): Promise<ActionResult> {
  const name = botName(bot);
  const spec = LIFECYCLE[kind];
  let phase: 'connecting' | 'sent' | 'refused' | 'accepted' = 'connecting';
  try {
    const outcome = await waitForEvent(client, { successTypes: [spec.success], failTypes: [spec.fail], timeoutMs: spec.waitMs }, async () => {
      phase = 'sent';
      const res = await client.request('POST', `/api/bots/${bot.id}/${kind}`);
      const b = res.body as { success?: boolean; opId?: unknown } | null;
      if (!res.ok || !b || b.success === false) {
        phase = 'refused';
        throw new Error(errorText(res));
      }
      phase = 'accepted';
      if (typeof b.opId !== 'string') throw new Error('the manager accepted the request but named no operation to follow');
      onAccepted?.(b.opId);
      return b.opId;
    });
    const d = outcome.event.data as { error?: unknown; warning?: unknown } | null;
    if (outcome.ok) return { ok: true, text: doneText(kind, name, d?.warning) };
    return { ok: false, text: `Could not ${VERB[kind]} ${name}: ${typeof d?.error === 'string' && d.error ? d.error : 'the manager gave no reason'}` };
  } catch (err) {
    const reason = why(err);
    if (phase === 'connecting') return { ok: false, text: `Could not reach the manager (${reason}), so ${name} was not asked to ${VERB[kind]}.` };
    if (phase === 'refused') return { ok: false, text: `Could not ${VERB[kind]} ${name}: ${reason}` };
    if (phase === 'sent') return { ok: null, text: `can't confirm ${unknownText(kind, name)}: the manager did not answer (${reason}).` };
    const tail = err instanceof WaitTimeoutError ? '; it may still be running' : '';
    return { ok: null, text: `can't confirm ${unknownText(kind, name)}: ${reason}${tail}.` };
  }
}

export async function listContainers(client: Client, bot: Bot): Promise<Container[]> {
  let res: CliResponse;
  try {
    res = await client.request('GET', `/api/bots/${bot.id}/containers`);
  } catch (err) {
    throw new Error(why(err));
  }
  const b = res.body as { success?: boolean; containers?: unknown } | null;
  if (!res.ok || !b || b.success === false || !Array.isArray(b.containers)) throw new Error(errorText(res));
  return b.containers as Container[];
}

export function buildLogPath(bot: Bot): string {
  return `/api/bots/${bot.id}/build-logs`;
}

export function containerLogPath(bot: Bot, container: string, lines = 200): string {
  return `/api/bots/${bot.id}/containers/${container}/logs/stream?lines=${lines}`;
}

export interface StreamEnd {
  text: string;
  ok: boolean | null;
}

/** One line per build-log frame; the terminal frames say how the operation ended, as `dbm bots build-logs` judges them. */
export function buildFrameLine(frame: Frame): { line?: string; key?: string; end?: StreamEnd } {
  const d = frame.data as Record<string, unknown> | null;
  if (!d || typeof d !== 'object') return {};
  const type = d.type;
  if (type === 'status') return {};
  if (type === 'idle') {
    if (d.cutOp) return { end: { ok: null, text: "A manager restart cut the bot's last operation, so its outcome can't be confirmed." } };
    return { end: { ok: true, text: `No operation is running. Bot status: ${String(d.status ?? 'unknown')}.` } };
  }
  if (type === 'done') return { end: { ok: true, text: `The ${String(d.op ?? 'operation')} finished. Bot status: ${String(d.currentStatus ?? 'unknown')}.` } };
  if (type === 'failed') return { end: { ok: false, text: `The ${String(d.op ?? 'operation')} failed: ${String(d.error ?? 'unknown error')}` } };
  if (typeof d.message !== 'string') return {};
  const prefix = type === 'error' ? 'Error: ' : type === 'warning' ? 'Warning: ' : '';
  return { line: prefix + d.message, ...(typeof d.key === 'string' ? { key: d.key } : {}) };
}

/** One line per container-log frame; an `end` frame ends the stream with docker logs' exit. */
export function containerFrameLine(frame: Frame): { line?: string; end?: StreamEnd } {
  const d = frame.data as Record<string, unknown> | null;
  if (frame.event === 'log') return { line: typeof d?.log === 'string' ? d.log : '' };
  if (frame.event === 'end') {
    if (d?.code === 0) return { end: { ok: true, text: 'docker logs exited; the stream ended.' } };
    const reason = typeof d?.error === 'string' ? d.error : `exit code ${d?.code ?? 'unknown'}`;
    return { end: { ok: false, text: `docker logs ended: ${reason}` } };
  }
  return {};
}

export interface StreamLines {
  lines: string[];
  end: StreamEnd | null;
}

const MAX_LINES = 2000;

/** Applies one parsed frame to the lines: a keyed line replaces its earlier copy, as the web page shows progress. */
export function applyLine(state: StreamLines, keys: Map<string, number>, parsed: { line?: string; key?: string; end?: StreamEnd }): void {
  if (parsed.end) state.end = parsed.end;
  if (parsed.line === undefined) return;
  if (parsed.key !== undefined && keys.has(parsed.key)) {
    state.lines[keys.get(parsed.key)!] = parsed.line;
    return;
  }
  if (parsed.key !== undefined) keys.set(parsed.key, state.lines.length);
  state.lines.push(parsed.line);
  if (state.lines.length > MAX_LINES) {
    const cut = state.lines.length - MAX_LINES;
    state.lines.splice(0, cut);
    for (const [k, i] of [...keys]) {
      if (i < cut) keys.delete(k);
      else keys.set(k, i - cut);
    }
  }
}

/** Follows an SSE route until its end, an error or the signal; `end` is null when the stream stopped without a closing frame. */
export async function followStream(
  client: Client,
  path: string,
  parse: (frame: Frame) => { line?: string; key?: string; end?: StreamEnd },
  state: StreamLines,
  onChange: () => void,
  signal?: AbortSignal,
): Promise<void> {
  const keys = new Map<string, number>();
  try {
    await client.sse(
      path,
      (frame) => {
        applyLine(state, keys, parse(frame));
        onChange();
      },
      { signal },
    );
    if (!state.end && !signal?.aborted) state.end = { ok: null, text: 'The manager closed the stream before it ended.' };
  } catch (err) {
    if (!signal?.aborted) state.end = { ok: false, text: `The stream failed: ${why(err)}` };
  }
  onChange();
}
