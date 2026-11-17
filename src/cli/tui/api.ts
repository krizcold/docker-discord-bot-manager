import { Client, CliResponse } from '../client';
import { waitForEvent, WaitTimeoutError } from '../waiter';

export interface Bot {
  id: string;
  displayName?: string;
  status?: string;
  sourceType?: string;
  activeOp?: string | null;
  fleetDb?: FleetDbView | null;
  fleetDbReplica?: { copyCleared?: boolean; takeover?: unknown; slot?: string } | null;
  fleetDbReplicaSeed?: { phase?: string } | null;
  dataPlace?: 'json' | 'outside' | null;
  fleetBackup?: FleetBackupStatus | null;
  fleetWorker?: boolean;
  hasDbBackups?: boolean;
  appHooks?: boolean;
  maintenance?: { state?: string; message?: string; settled?: boolean; orderedAt?: string; lastError?: string | null; held?: Held | null } | null;
  maintenanceDrift?: string | null;
  fenceStuck?: string | null;
  migrate?: MigrateRecordView | null;
  migrateLast?: MigrateLastView | null;
  updateAvailable?: boolean;
  updateCantConfirm?: string;
  behindBy?: number;
  hasBeenStarted?: boolean;
  lastStartAt?: number;
  publicUrl?: string;
  webAuth?: WebAuthMode;
}

export type WebAuthMode = 'auto' | 'managed' | 'public';

/** The bot's last answer about the changes it holds (src/types/index.ts:399). */
export interface Held {
  state?: string;
  guilds?: number;
  files?: number;
  note?: string;
}

/** An open migration record (src/types/index.ts:419), as the list route and GET migrate carry it. */
export interface MigrateRecordView {
  to?: string;
  phase?: string;
  text?: string;
  openedAt?: string | number;
}

/** The last migration's outcome (src/types/index.ts:447). */
export interface MigrateLastView {
  to?: string;
  outcome?: string;
  text?: string;
  at?: string;
}

export interface BackupAlert {
  text?: string;
  since?: number;
  dm?: string;
  dmAt?: number;
  dmError?: string;
  dmPlace?: string;
  dmNote?: string;
  dmRepeat?: boolean;
}

export interface BackupTest {
  file?: string;
  startedAt?: number;
  finishedAt?: number;
  result?: string;
  text?: string;
  tables?: number;
  rows?: number;
}

/** One family of fleetBackupStatus (src/instance/fleetBackup.ts:1535). */
export interface BackupFamilyStatus {
  family?: 'main' | 'copy';
  enabled?: boolean;
  hour?: number;
  paused?: boolean;
  lastFile?: string | null;
  lastAt?: number | null;
  dataAt?: number | null;
  lastError?: string | null;
  failingSince?: number | null;
  listError?: string | null;
  skip?: 'scope' | 'seed' | null;
  test?: BackupTest | null;
  alerts?: { dumps?: BackupAlert | null; test?: BackupAlert | null };
}

/** fleetBackupStatus (src/instance/fleetBackup.ts:1549), carried by every bot of the list. */
export interface FleetBackupStatus {
  enabled?: boolean;
  hour?: number;
  scoped?: boolean | null;
  restoreError?: string | null;
  restoreErrorAt?: string | null;
  main?: BackupFamilyStatus | null;
  copy?: BackupFamilyStatus | null;
}

/** The switch records of a bot's fleetDb as the list route sends them (src/types/index.ts:61 to 66). */
export interface FleetDbView {
  replication?: { publicHost?: string; hostPort?: number } | null;
  handover?: { mode?: string; phase?: string; machine?: string; host?: string; at?: string; lastCheck?: string; file?: string } | null;
  receive?: { expiresAt?: string; safetyDump?: string } | null;
  replacedBy?: { machine?: string; generation?: number } | null;
  mainConflict?: { machine?: string; blockError?: string } | null;
  pushBroken?: { at?: string; safetyDump?: string } | null;
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
  return (await readBotList(client)).bots;
}

/** GET /api/bots (bots.ts:153): the bots and, when the manager could decide it, the deployment mode (bots.ts:242). */
export async function readBotList(client: Client): Promise<{ bots: Bot[]; deploymentMode: string | null }> {
  let res: CliResponse;
  try {
    res = await client.request('GET', '/api/bots');
  } catch (err) {
    throw new Error(why(err));
  }
  const body = res.body as { success?: boolean; bots?: unknown; deploymentMode?: unknown } | null;
  if (!res.ok || !body || typeof body !== 'object' || body.success === false) throw new Error(errorText(res));
  if (!Array.isArray(body.bots)) throw new Error('the answer held no bot list');
  const mode = typeof body.deploymentMode === 'string' && body.deploymentMode ? body.deploymentMode : null;
  return { bots: body.bots as Bot[], deploymentMode: mode };
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

export interface Source {
  id: string;
  url?: string;
  branch?: string;
  composeName?: string | null;
  sourceType?: string;
  imageRef?: string;
  isCloned?: boolean;
  cloneError?: string | null;
}

/** The page's getRepoName: the last path part of a git URL, without .git or credentials. */
export function repoName(url: string | undefined): string | null {
  if (!url) return null;
  const match = url.replace(/\/\/([^@]+)@/, '//').match(/\/([^/]+?)(?:\.git)?$/);
  return match ? match[1] : url;
}

export function sourceName(source: Source): string {
  return source.composeName || repoName(source.url) || source.imageRef || source.url || source.id;
}

export function defaultBotName(source: Source | undefined): string {
  return source ? source.composeName || repoName(source.url) || 'My Bot' : 'My Bot';
}

export function isImageSource(source: Source | undefined): boolean {
  return !!source && source.sourceType === 'docker-image';
}

export type Outcome<T> = { ok: true; value: T } | { ok: false; text: string } | { ok: null; text: string };

type Body = Record<string, unknown>;

async function call(client: Client, method: string, path: string, body?: unknown, limitMs?: number): Promise<Outcome<Body>> {
  return (await send(client, method, path, body, limitMs)).outcome;
}

async function send(client: Client, method: string, path: string, body?: unknown, limitMs?: number): Promise<{ status: number | null; outcome: Outcome<Body> }> {
  let res: CliResponse;
  try {
    const sent = client.request(method, path, body === undefined ? {} : { body });
    res = limitMs === undefined ? await sent : await withinLimit(sent, limitMs);
  } catch (err) {
    return { status: null, outcome: { ok: null, text: why(err) } };
  }
  const b = res.body as Body | null;
  // The page reads a reply it cannot parse as no answer (index.html:1388): what the manager did is unknown.
  if (!b || typeof b !== 'object') return { status: res.status, outcome: { ok: null, text: `the reply was not JSON, HTTP ${res.status}` } };
  return { status: res.status, outcome: { ok: true, value: b } };
}

// Client.request sets no time limit; a reply that comes later than the limit is dropped.
function withinLimit<T>(sent: Promise<T>, limitMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`the manager did not answer within ${limitMs % 1000 === 0 ? `${limitMs / 1000} s` : `${limitMs} ms`}`)), limitMs);
    timer.unref?.();
    sent.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

const bare = (text: string): string => text.replace(/[.\s]+$/, '');
const failed = (b: Body): boolean => b.success !== true;
const bodyError = (b: Body, fallback: string): string => (typeof b.error === 'string' && b.error ? b.error : fallback);

// The same route as `dbm bots containers` (bots.ts:928); the fallback is the page's (index.html:5364).
export async function readContainers(client: Client, botId: string, limitMs: number): Promise<Outcome<Container[]>> {
  const r = await call(client, 'GET', `/api/bots/${botId}/containers`, undefined, limitMs);
  if (r.ok !== true) return r;
  if (failed(r.value)) return { ok: false, text: bodyError(r.value, 'Could not read the containers from docker') };
  if (!Array.isArray(r.value.containers)) return { ok: null, text: 'the answer held no container list' };
  return { ok: true, value: r.value.containers as Container[] };
}

export interface FsEntry {
  name: string;
  isDir: boolean;
}

export interface FsListing {
  path: string;
  entries: FsEntry[];
}

export interface FsFile {
  path: string;
  body: string;
  eol: 'lf' | 'crlf';
}

/**
 * A files route's answer. `unsure` is a write the route could not confirm: `unconfirmed` (terminal.ts:390), or a
 * container operation stopped at its bound (terminal.ts:1251, :1276), which carries no flag of its own.
 */
export type FsAnswer<T> =
  | { ok: true; value: T }
  | { ok: false; text: string; exists?: boolean }
  | { ok: 'unsure'; text: string }
  | { ok: null; text: string };

const STOPPED_AT_BOUND = /^The (delete of .+|rename) was stopped after \d+ s[;,]/;

const fsQuery = (target: string, path: string): string => `target=${encodeURIComponent(target)}&path=${encodeURIComponent(path)}`;

function fsAnswer(r: Outcome<Body>, fallback: string): FsAnswer<Body> {
  if (r.ok !== true) return r;
  const b = r.value;
  if (b.success === true) return { ok: true, value: b };
  const text = bodyError(b, '');
  if (b.unconfirmed === true || STOPPED_AT_BOUND.test(text)) return { ok: 'unsure', text: text || fallback };
  return { ok: false, text: text || fallback, ...(b.exists === true ? { exists: true } : {}) };
}

/** GET /api/bots/:id/fs/list (bots.ts:1464, terminal.ts:1145); the fallback is the page's (index.html:5493). */
export async function fsList(client: Client, botId: string, target: string, path: string, limitMs: number): Promise<FsAnswer<FsListing>> {
  const r = fsAnswer(await call(client, 'GET', `/api/bots/${botId}/fs/list?${fsQuery(target, path)}`, undefined, limitMs), 'Failed to list');
  if (r.ok !== true) return r;
  const { path: at, entries } = r.value;
  if (typeof at !== 'string' || !Array.isArray(entries)) return { ok: null, text: 'the answer held no listing' };
  const rows = (entries as Array<Partial<FsEntry> | null>)
    .filter((e): e is Partial<FsEntry> & { name: string } => !!e && typeof e.name === 'string' && e.name !== '')
    .map((e) => ({ name: e.name, isDir: e.isDir === true }));
  return { ok: true, value: { path: at, entries: rows } };
}

/** GET /api/bots/:id/fs/read (bots.ts:1473, terminal.ts:1164); the fallback is the page's (index.html:5541). */
export async function fsRead(client: Client, botId: string, target: string, path: string, limitMs: number): Promise<FsAnswer<FsFile>> {
  const r = fsAnswer(await call(client, 'GET', `/api/bots/${botId}/fs/read?${fsQuery(target, path)}`, undefined, limitMs), 'Cannot open file');
  if (r.ok !== true) return r;
  const { path: at, body, eol } = r.value;
  if (typeof body !== 'string') return { ok: null, text: 'the answer held no file body' };
  return { ok: true, value: { path: typeof at === 'string' ? at : path, body, eol: eol === 'crlf' ? 'crlf' : 'lf' } };
}

/** PUT /api/bots/:id/fs/write (bots.ts:1482, terminal.ts:1183). Writes have no time limit. */
export async function fsWrite(client: Client, botId: string, body: { target: string; path: string; body: string; eol: 'lf' | 'crlf' }): Promise<FsAnswer<Body>> {
  return fsAnswer(await call(client, 'PUT', `/api/bots/${botId}/fs/write`, body), 'Not saved');
}

/** POST /api/bots/:id/fs/create (bots.ts:1496, terminal.ts:1212). */
export async function fsCreate(client: Client, botId: string, target: string, path: string): Promise<FsAnswer<Body>> {
  return fsAnswer(await call(client, 'POST', `/api/bots/${botId}/fs/create`, { target, path }), 'Failed to create file');
}

/** POST /api/bots/:id/fs/mkdir (bots.ts:1507, terminal.ts:1226). */
export async function fsMkdir(client: Client, botId: string, target: string, path: string): Promise<FsAnswer<Body>> {
  return fsAnswer(await call(client, 'POST', `/api/bots/${botId}/fs/mkdir`, { target, path }), 'Failed to create folder');
}

/** POST /api/bots/:id/fs/delete (bots.ts:1518, terminal.ts:1239): `removed` says whether anything was there. */
export async function fsDelete(client: Client, botId: string, target: string, path: string): Promise<FsAnswer<{ removed: boolean }>> {
  const r = fsAnswer(await call(client, 'POST', `/api/bots/${botId}/fs/delete`, { target, path }), 'Failed to delete');
  if (r.ok !== true) return r;
  return { ok: true, value: { removed: r.value.removed === true } };
}

/** POST /api/bots/:id/fs/rename (bots.ts:1529, terminal.ts:1258): `overwrite` is sent only after the operator's own Y. */
export async function fsRename(client: Client, botId: string, body: { target: string; from: string; to: string; overwrite?: true }): Promise<FsAnswer<Body>> {
  return fsAnswer(await call(client, 'POST', `/api/bots/${botId}/fs/rename`, body), 'Failed to rename');
}

export type DeleteFlag = 'confirmPromoted' | 'confirmFleetData';

/** The success body of DELETE /api/bots/:id (bots.ts:516 to :521). */
export interface DeleteDone {
  vaulted: boolean;
  envDeleted: boolean;
  keptDataDir?: string;
  dbDumpsKept?: { count: number; folder: string };
  keptReplicaVolume?: string;
  /** What the delete left for another machine's operator (deleteBot's notes, R24). */
  warning?: string;
}

export type DeleteAnswer =
  | { ok: true; value: DeleteDone }
  | { ok: 'question'; text: string; flag: DeleteFlag }
  | { ok: false; text: string }
  | { ok: null; text: string };

/**
 * DELETE /api/bots/:id (bots.ts:390), as `dbm bots delete` and the page's confirmDeleteBot (index.html:2077) send it;
 * no time limit. A question (instanceRemovalRefusal, fleetReplica.ts:1283) names the one flag that answers it.
 */
export async function deleteBot(client: Client, botId: string, keepData: boolean, keepEnv: boolean, flags: DeleteFlag[]): Promise<DeleteAnswer> {
  const query = `keepData=${keepData}&keepEnv=${keepEnv}${flags.map((f) => `&${f}=true`).join('')}`;
  const r = await call(client, 'DELETE', `/api/bots/${encodeURIComponent(botId)}?${query}`);
  if (r.ok !== true) return r;
  const b = r.value;
  if (b.success !== true) {
    const text = bodyError(b, 'Failed to remove bot');
    if (b.needsConfirm === true && (b.confirmFlag === 'confirmPromoted' || b.confirmFlag === 'confirmFleetData')) return { ok: 'question', text, flag: b.confirmFlag };
    return { ok: false, text };
  }
  const dumps = b.dbDumpsKept as { count?: unknown; folder?: unknown } | undefined;
  return {
    ok: true,
    value: {
      vaulted: b.vaulted === true,
      envDeleted: b.envDeleted === true,
      ...(typeof b.keptDataDir === 'string' && b.keptDataDir ? { keptDataDir: b.keptDataDir } : {}),
      ...(dumps && typeof dumps.count === 'number' && typeof dumps.folder === 'string' ? { dbDumpsKept: { count: dumps.count, folder: dumps.folder } } : {}),
      ...(typeof b.keptReplicaVolume === 'string' && b.keptReplicaVolume ? { keptReplicaVolume: b.keptReplicaVolume } : {}),
      ...(typeof b.warning === 'string' && b.warning ? { warning: b.warning } : {}),
    },
  };
}

/** PUT /api/bots/:id/web-auth (bots.ts:2298); no time limit. The fallback is the page's (index.html:1971). */
export async function setWebAuth(client: Client, botId: string, mode: WebAuthMode): Promise<Outcome<Body>> {
  const r = await call(client, 'PUT', `/api/bots/${encodeURIComponent(botId)}/web-auth`, { mode });
  if (r.ok !== true) return r;
  if (failed(r.value)) return { ok: false, text: bodyError(r.value, 'Failed to set web auth mode') };
  return r;
}

/** The record of the last manager update (LastUpdate, selfUpdate.ts:42). */
export interface ManagerLastUpdate {
  opId?: string;
  state?: string;
  target?: string;
  message?: string;
  at?: string;
}

/** GET /api/manager/version (manager.ts:17): ManagerVersion (selfUpdate.ts:55 to :73) with `success`. */
export interface ManagerVersion {
  supported?: boolean;
  bootId?: string;
  reason?: string;
  currentCommit?: string;
  stamped?: boolean;
  repoCommit?: string;
  checked?: boolean;
  fetchError?: string;
  updateAvailable?: boolean;
  behindBy?: number;
  buildStale?: boolean;
  stackPending?: boolean;
  updateInProgress?: boolean;
  lastUpdate?: ManagerLastUpdate | null;
}

/** The route runs git fetch for up to 30 s (selfUpdate.ts:394); the read waits longer than that. */
export const VERSION_READ_MS = 45_000;

export function readManagerVersion(client: Client, limitMs: number): Read<ManagerVersion> {
  return read<ManagerVersion>(client, '/api/manager/version', limitMs);
}

/** POST /api/manager/update (manager.ts:33): `{success, opId, message}` (:58), or a refusal, `inProgress` on a running update (:39, :54). No time limit. */
export function postManagerUpdate(client: Client): Promise<Outcome<Body>> {
  return call(client, 'POST', '/api/manager/update');
}

/** /ws for the manager's update frames (manager.ts:60 to :78); `opened` settles with null once it is open, or the reason it did not open. */
export function openManagerStream(
  client: Client, onFrame: (type: string, data: Record<string, unknown>) => void, onLost: (reason: string) => void,
): { opened: Promise<string | null>; close: () => void } {
  let conn: { close: () => void } | null = null;
  let opened = false;
  let settle: (v: string | null) => void = () => undefined;
  const result = new Promise<string | null>((resolve) => {
    settle = resolve;
  });
  try {
    conn = client.openWs(
      (msg) => {
        const d = msg.data;
        if (!msg.type.startsWith('manager:') || !d || typeof d !== 'object' || Array.isArray(d)) return;
        onFrame(msg.type, d as Record<string, unknown>);
      },
      () => {
        if (opened) return;
        opened = true;
        settle(null);
      },
      (reason) => {
        if (!opened) {
          opened = true;
          settle(reason);
          return;
        }
        onLost(reason);
      },
    );
  } catch (err) {
    opened = true;
    settle(why(err));
  }
  return {
    opened: result,
    close: () => {
      try {
        conn?.close();
      } catch {
        // A channel that failed to open has nothing to close.
      }
    },
  };
}

/** GET /api/system/deployment (bots.ts:2469): getDeploymentInfo (detector.ts:198). */
export interface DeploymentInfo {
  mode?: string;
  casaosAvailable?: boolean;
  autoDetected?: boolean;
  forcedByEnv?: boolean;
}

export function readDeployment(client: Client, limitMs: number): Read<DeploymentInfo> {
  return read<DeploymentInfo>(client, '/api/system/deployment', limitMs);
}

export type DeploymentAnswer =
  | { kind: 'set'; info: DeploymentInfo }
  | { kind: 'saved'; mode: string; text: string }
  | { kind: 'refused'; text: string }
  | { kind: 'unsure'; text: string };

const NOT_SAVED = 'The deployment mode could not be saved';

/**
 * PUT /api/system/deployment (bots.ts:2511); no time limit. Only the 409 of a forced mode (detector.ts:170) and the 500
 * that names an unsaved mode (bots.ts:2525) say nothing changed; every other refusal leaves the mode unknown. A saved
 * mode whose details could not be read answers success with a `warning` and no details (bots.ts:2530).
 */
export async function setDeployment(client: Client, mode: 'casaos' | 'docker'): Promise<DeploymentAnswer> {
  const { status, outcome } = await send(client, 'PUT', '/api/system/deployment', { mode });
  if (outcome.ok !== true) return { kind: 'unsure', text: outcome.text };
  const b = outcome.value;
  if (b.success === true) {
    if (typeof b.warning === 'string') return { kind: 'saved', mode: typeof b.mode === 'string' ? b.mode : mode, text: b.warning };
    return { kind: 'set', info: b as DeploymentInfo };
  }
  const error = typeof b.error === 'string' ? b.error : '';
  if (status === 409 && error) return { kind: 'refused', text: error };
  if (status === 500 && error.startsWith(NOT_SAVED)) return { kind: 'refused', text: error };
  return { kind: 'unsure', text: error || `HTTP ${status}` };
}

// The same route and body as `dbm sources list`.
export async function listSources(client: Client): Promise<Source[]> {
  const r = await call(client, 'GET', '/api/sources');
  if (r.ok !== true) throw new Error(r.text);
  if (failed(r.value)) throw new Error(bodyError(r.value, 'the manager gave no reason'));
  if (!Array.isArray(r.value.sources)) throw new Error('the answer held no source list');
  return r.value.sources as Source[];
}

// The same route and body as `dbm sources add`; the page sends main when the branch is left blank.
export async function addSource(client: Client, url: string, branch: string): Promise<Outcome<Source>> {
  const r = await call(client, 'POST', '/api/sources', { url, branch: branch || 'main' });
  if (r.ok !== true) return r;
  if (failed(r.value)) return { ok: false, text: bodyError(r.value, 'Failed to add source') };
  return { ok: true, value: r.value.source as Source };
}

export interface FetchAnswer {
  hasUpdates?: boolean;
  copyError?: string;
}

// The same route as `dbm sources fetch`; for a source that is not cloned yet the fetch clones it.
export async function fetchSource(client: Client, id: string): Promise<Outcome<FetchAnswer>> {
  const r = await call(client, 'POST', `/api/sources/${id}/fetch`);
  if (r.ok !== true) return r;
  if (failed(r.value)) return { ok: false, text: bodyError(r.value, 'Fetch failed') };
  return { ok: true, value: r.value as FetchAnswer };
}

export interface EnvHint {
  key: string;
  displayLabel?: string;
  label?: string;
  description?: string;
  defaultValue?: string;
  required?: boolean;
  sensitive?: boolean;
  autoWired?: boolean;
  inactive?: string;
  options?: Array<{ value: string; label?: string }>;
  generate?: boolean;
  showWhen?: { key: string; equals: string | string[] };
  requiredWhen?: { key: string; equals: string | string[] };
  advanced?: boolean;
  group?: string;
  groupHelp?: string;
  placeholder?: string;
  inputType?: 'number';
  min?: number;
  max?: number;
  step?: number;
  list?: boolean;
}

export interface ConfigHint {
  inContainerPath: string;
  rawBody?: string;
  manifest?: unknown;
  format?: string;
  parsed?: unknown;
  repoReadOnly?: boolean;
}

export interface SourceEnvs {
  success?: boolean;
  error?: string;
  vars?: EnvHint[];
  configFiles?: ConfigHint[];
  interactiveSetup?: { reason?: string; advice?: string } | null;
  sourceScan?: { scanned: number; total: number } | null;
  imageReady?: boolean;
  pullError?: string;
  inspectError?: string;
}

/** GET /api/sources/:id/envs as the page reads it; scan runs the source-code scan, inspect pulls and inspects an image. */
export async function readSourceEnvs(client: Client, id: string, mode?: 'scan' | 'inspect'): Promise<Outcome<SourceEnvs>> {
  const query = mode === 'scan' ? '?scan=true' : mode === 'inspect' ? '?inspect=true' : '';
  const r = await call(client, 'GET', `/api/sources/${id}/envs${query}`);
  if (r.ok !== true) return r;
  return { ok: true, value: r.value as SourceEnvs };
}

export interface NameCheck {
  valid?: boolean;
  errors?: string[];
  success?: boolean;
  error?: string;
  sanitizedName?: string;
  displayName?: string;
  adjusted?: boolean;
  conflicts?: string[];
  reuseAvailable?: boolean;
  keptSource?: string | null;
  envsAvailable?: boolean | 'unknown';
}

function nameQuery(name: string, sourceId: string | undefined): string {
  return `name=${encodeURIComponent(name)}${sourceId ? `&sourceId=${encodeURIComponent(sourceId)}` : ''}`;
}

/** GET /api/validate-name, the page's live name check. */
export async function validateName(client: Client, name: string, sourceId: string | undefined): Promise<Outcome<NameCheck>> {
  const r = await call(client, 'GET', `/api/validate-name?${nameQuery(name, sourceId)}`);
  if (r.ok !== true) return r;
  return { ok: true, value: r.value as NameCheck };
}

export interface RecoveredEnvs {
  success?: boolean;
  error?: string;
  envs?: Array<{ key: string; value: string; sensitive?: boolean; source?: string }>;
  vaultBroken?: boolean;
}

/** GET /api/recover-envs, the page's Load envs. */
export async function recoverEnvs(client: Client, name: string, sourceId: string | undefined): Promise<Outcome<RecoveredEnvs>> {
  const r = await call(client, 'GET', `/api/recover-envs?${nameQuery(name, sourceId)}`);
  if (r.ok !== true) return r;
  return { ok: true, value: r.value as RecoveredEnvs };
}

export interface ConfigFileBody {
  path: string;
  body: string;
  readOnly?: boolean;
  enabled: boolean;
}

export interface InstallPlan {
  sourceId: string;
  name: string;
  vars: Record<string, string>;
  configFiles: ConfigFileBody[];
}

export type InstallStep = 'create' | 'env' | 'config';

export interface InstallResult {
  ok: boolean | null;
  text: string;
  /** The bot this install created, kept so a retry never creates a second one. */
  botId: string | null;
}

/**
 * doInstall's calls in its order: POST /api/bots (as `dbm bots create --source`), PUT env (as `dbm env set`) when a
 * value is set, PUT config (as `dbm config set`) when there are files. A retry passes the bot an earlier run created.
 */
export async function installBot(
  client: Client,
  plan: InstallPlan,
  createdId: string | null,
  onStep: (step: InstallStep, state: 'running' | 'done' | 'skipped') => void,
): Promise<InstallResult> {
  let botId = createdId;
  if (!botId) {
    onStep('create', 'running');
    const r = await call(client, 'POST', '/api/bots', { sourceId: plan.sourceId, displayName: plan.name });
    if (r.ok === null) return { ok: null, botId: null, text: `can't confirm the bot was created: the manager did not answer (${r.text}). Check the bot list before trying again.` };
    if (r.ok === false) return { ok: false, botId: null, text: `Could not create the bot: ${bare(r.text)}. Nothing was created.` };
    if (failed(r.value)) return { ok: false, botId: null, text: `Could not create the bot: ${bare(bodyError(r.value, 'Failed to create instance'))}. Nothing was created.` };
    const made = r.value.bot as { id?: unknown } | undefined;
    if (!made || typeof made.id !== 'string') return { ok: null, botId: null, text: "can't confirm the bot was created: the answer named no bot. Check the bot list before trying again." };
    botId = made.id;
    onStep('create', 'done');
  } else {
    onStep('create', 'skipped');
  }
  const label = `${plan.name} (${botId})`;
  const warnings: string[] = [];
  const save = async (step: 'env' | 'config', what: string, path: string, body: unknown): Promise<InstallResult | null> => {
    onStep(step, 'running');
    const r = await call(client, 'PUT', path, body);
    if (r.ok === null) return { ok: null, botId, text: `The bot ${label} was created, but can't confirm its ${what} were saved: the manager did not answer (${r.text}).` };
    const error = r.ok === false ? r.text : failed(r.value) ? bodyError(r.value, 'unknown error') : null;
    if (error !== null) return { ok: false, botId, text: `The bot ${label} was created; its ${what} were not saved: ${bare(error)}.` };
    if (r.ok && typeof r.value.warning === 'string' && r.value.warning) warnings.push(r.value.warning);
    onStep(step, 'done');
    return null;
  };
  if (Object.values(plan.vars).some((v) => v)) {
    const stop = await save('env', 'environment variables', `/api/bots/${botId}/env`, { vars: plan.vars });
    if (stop) return stop;
  } else {
    onStep('env', 'skipped');
  }
  if (plan.configFiles.length > 0) {
    const stop = await save('config', 'config files', `/api/bots/${botId}/config`, { files: plan.configFiles });
    if (stop) return stop;
  } else {
    onStep('config', 'skipped');
  }
  const warning = warnings.length ? ` Warning: ${warnings.join(' ')}` : '';
  return { ok: true, botId, text: `Bot instance ${label} created. Open it in the bot list and press S to install and run it.${warning}` };
}

export interface ConfigOp {
  path: string;
  value?: unknown;
  remove?: boolean;
  insert?: boolean;
}

/** POST /api/config/parse, the guided form's raw body to values. */
export async function parseConfigBody(client: Client, format: string, body: string): Promise<Outcome<{ success?: boolean; ok?: boolean; data?: unknown; error?: string }>> {
  return call(client, 'POST', '/api/config/parse', { format, body });
}

/** POST /api/config/serialize, the guided form's changes written into the raw body. */
export async function serializeConfigBody(client: Client, format: string, body: string, ops: ConfigOp[]): Promise<Outcome<{ success?: boolean; body?: unknown; skipped?: unknown; error?: string }>> {
  return call(client, 'POST', '/api/config/serialize', { format, body, ops });
}

export interface DiscordCheck {
  success?: boolean;
  status?: string;
  name?: string;
  resolvedKind?: string;
  reason?: string;
  error?: string;
}

/** POST /api/discord/validate, the guided form's id check; the token goes only into the request body. */
export async function validateDiscordId(
  client: Client, check: { token: string; kind: string; id: string; guildId?: unknown },
): Promise<Outcome<DiscordCheck>> {
  return call(client, 'POST', '/api/discord/validate', check);
}

/** One row of GET /api/bots/:id/env (buildBotEnvList): a stored secret comes back blank. */
export interface EditorVar extends EnvHint {
  value?: string;
  isSet?: boolean;
  undecryptable?: boolean;
  semantic?: string;
}

export interface BotEnv {
  success?: boolean;
  error?: string;
  vars?: EditorVar[];
  tokenVarName?: string;
  missing?: string[];
  undecryptable?: string[];
  storeBroken?: boolean;
  corruptCopies?: string[];
  secretKeyProblem?: string | null;
}

// The same route as `dbm env get`.
export async function readBotEnv(client: Client, botId: string): Promise<Outcome<BotEnv>> {
  const r = await call(client, 'GET', `/api/bots/${botId}/env`);
  if (r.ok !== true) return r;
  return { ok: true, value: r.value as BotEnv };
}

export interface EnvSave {
  vars: Record<string, string>;
  removed?: string[];
  renamed?: Record<string, string>;
}

export interface EnvSaveAnswer {
  success?: boolean;
  error?: string;
  removed?: string[];
  stillStored?: string[];
  notApplied?: boolean;
  warning?: string;
}

// The route `dbm env set` calls, with the env editor's body (the keys it removes and renames too).
export async function saveBotEnv(client: Client, botId: string, body: EnvSave): Promise<Outcome<EnvSaveAnswer>> {
  const r = await call(client, 'PUT', `/api/bots/${botId}/env`, body);
  if (r.ok !== true) return r;
  return { ok: true, value: r.value as EnvSaveAnswer };
}

export interface DbCheck {
  success?: boolean;
  ok?: boolean;
  error?: string;
  hint?: string;
  notTested?: boolean;
}

/** POST /api/bots/:id/validate-db, the env editor's test of a new database URL. */
export async function validateDb(client: Client, botId: string, url: string): Promise<Outcome<DbCheck>> {
  const r = await call(client, 'POST', `/api/bots/${botId}/validate-db`, { url });
  if (r.ok !== true) return r;
  return { ok: true, value: r.value as DbCheck };
}

export interface VaultValue {
  key: string;
  value: string;
  source: string;
}

// The same route as `dbm vault values`.
export async function vaultValues(client: Client): Promise<Outcome<VaultValue[]>> {
  const r = await call(client, 'GET', '/api/vault/all-values');
  if (r.ok !== true) return r;
  if (r.value.success !== true) return { ok: false, text: bodyError(r.value, 'the manager gave no reason') };
  if (!Array.isArray(r.value.values)) return { ok: false, text: 'the answer held no vault values' };
  return { ok: true, value: r.value.values as VaultValue[] };
}

/** One file of GET /api/bots/:id/config (buildBotConfigList, with the guided manifest and parse). */
export interface BotConfigFile {
  path: string;
  body?: string;
  readOnly?: boolean;
  repoReadOnly?: boolean;
  enabled?: boolean;
  bodyUndecryptable?: boolean;
  inactive?: string;
  fromTemplate?: boolean;
  manifest?: unknown;
  format?: string;
  parsed?: unknown;
}

export interface BotConfig {
  success?: boolean;
  error?: string;
  files?: BotConfigFile[];
  storeBroken?: boolean;
  corruptCopies?: string[];
  secretKeyProblem?: string | null;
}

// The same route as `dbm config get`.
export async function readBotConfig(client: Client, botId: string): Promise<Outcome<BotConfig>> {
  const r = await call(client, 'GET', `/api/bots/${botId}/config`);
  if (r.ok !== true) return r;
  return { ok: true, value: r.value as BotConfig };
}

export interface ConfigSaveAnswer {
  success?: boolean;
  error?: string;
  needsUpdate?: boolean;
  mountsUnknown?: boolean;
}

// The same route and body as `dbm config set`.
export async function saveBotConfig(client: Client, botId: string, files: ConfigFileBody[]): Promise<Outcome<ConfigSaveAnswer>> {
  const r = await call(client, 'PUT', `/api/bots/${botId}/config`, { files });
  if (r.ok !== true) return r;
  return { ok: true, value: r.value as ConfigSaveAnswer };
}

export interface VaultGroupEntry {
  key: string;
  value: string;
  masked: string;
  hidden?: boolean;
}

export interface VaultGroup {
  id: string;
  name: string;
  type: 'instance' | 'standalone' | 'deleted';
  deletedAt?: number;
  entries: VaultGroupEntry[];
}

export interface VaultList {
  success?: boolean;
  error?: string;
  groups?: VaultGroup[];
  vaultBroken?: boolean;
  vaultError?: string;
  corruptCopies?: string[];
  secretKeyProblem?: string | null;
}

export interface Answer {
  success?: boolean;
  error?: string;
  warning?: string;
  notApplied?: boolean;
}

// The same route as `dbm vault list`.
export async function readVault(client: Client): Promise<Outcome<VaultList>> {
  const r = await call(client, 'GET', '/api/vault');
  if (r.ok !== true) return r;
  return { ok: true, value: r.value as VaultList };
}

// The route `dbm vault set` calls, with the page's hidden flag.
export async function addVaultEntry(client: Client, key: string, value: string, hidden: boolean): Promise<Outcome<Answer>> {
  return call(client, 'POST', '/api/vault/standalone', { key, value, hidden });
}

// The route `dbm vault update` calls; the page also sends newKey for a rename and leaves out an empty value.
export async function updateVaultEntry(client: Client, key: string, body: { newKey?: string; value?: string }): Promise<Outcome<Answer>> {
  return call(client, 'PUT', `/api/vault/standalone/${encodeURIComponent(key)}`, body);
}

// The same route as `dbm vault rm`.
export async function removeVaultEntry(client: Client, key: string): Promise<Outcome<Answer>> {
  return call(client, 'DELETE', `/api/vault/standalone/${encodeURIComponent(key)}`);
}

/** PUT /api/vault/deleted/:key?groupId=, an entry kept from a removed bot. */
export async function updateDeletedEntry(client: Client, groupId: string, key: string, body: { newKey?: string; value?: string }): Promise<Outcome<Answer>> {
  return call(client, 'PUT', `/api/vault/deleted/${encodeURIComponent(key)}?groupId=${encodeURIComponent(groupId)}`, body);
}

/** DELETE /api/vault/deleted/:key?groupId=. */
export async function removeDeletedEntry(client: Client, groupId: string, key: string): Promise<Outcome<Answer>> {
  return call(client, 'DELETE', `/api/vault/deleted/${encodeURIComponent(key)}?groupId=${encodeURIComponent(groupId)}`);
}

/** DELETE /api/vault/deleted-group/:id, a removed bot's whole group. */
export async function removeDeletedGroup(client: Client, groupId: string): Promise<Outcome<Answer>> {
  return call(client, 'DELETE', `/api/vault/deleted-group/${encodeURIComponent(groupId)}`);
}

type Read<T> = Promise<Outcome<T>>;

// A refusal's text is the route's error, or '' when it named none (the caller words that case).
async function read<T>(client: Client, path: string, limitMs: number): Read<T> {
  const r = await call(client, 'GET', path, undefined, limitMs);
  if (r.ok !== true) return r;
  if (r.value.success !== true) return { ok: false, text: bodyError(r.value, '') };
  return { ok: true, value: r.value as T };
}

export interface BackupEntry {
  file: string;
  size: number;
  mtime: number;
  kind?: string;
  family?: string;
  takenAt?: number;
  tables?: number | null;
  rows?: number | null;
}

/** GET /api/bots/:id/fleet-backups (bots.ts:1722): the dumps newest first; removed is set for a removed bot's folder. */
export function readFleetBackups(client: Client, botId: string, limitMs: number): Read<{ backups?: BackupEntry[]; removed?: boolean }> {
  return read(client, `/api/bots/${botId}/fleet-backups`, limitMs);
}

/** GET /api/bots/fleet/orphan-backups (bots.ts:1704): dump folders whose bot was removed. */
export function readOrphanBackups(client: Client, limitMs: number): Read<{ folders?: Array<{ id: string; dumps: number | null; folder: string }> }> {
  return read(client, '/api/bots/fleet/orphan-backups', limitMs);
}

export interface MaintenanceInfo {
  state?: string;
  message?: string;
  settled?: boolean;
  kind?: string | null;
  orderedAt?: string;
  lastError?: string | null;
  summary?: string;
  held?: Held | null;
}

/** GET /api/bots/:id/maintenance (bots.ts:528), src/instance/maintenance.ts:734. */
export function readMaintenance(client: Client, botId: string, limitMs: number): Read<MaintenanceInfo> {
  return read(client, `/api/bots/${botId}/maintenance`, limitMs);
}

export interface MemoryAnswer {
  memory?: { running?: boolean | null; room?: boolean | null; useMb?: number | null; freeMb?: number | null; error?: string };
  sent?: { kind?: string; unknown?: boolean; error?: string };
}

/** GET /api/bots/:id/memory (bots.ts:1009), src/instance/memoryRoom.ts:23. */
export function readMemory(client: Client, botId: string, limitMs: number): Read<MemoryAnswer> {
  return read(client, `/api/bots/${botId}/memory`, limitMs);
}

export interface ConnectionsAnswer {
  connections?: { state?: string; error?: string; machines?: number; count?: number; overlap?: boolean; max?: number; reserved?: number; allowed?: number };
}

/** GET /api/bots/:id/fleet-connections (bots.ts:1847), src/instance/fleetReplication.ts:1013. */
export function readConnections(client: Client, botId: string, limitMs: number): Read<ConnectionsAnswer> {
  return read(client, `/api/bots/${botId}/fleet-connections`, limitMs);
}

export interface ReplicationSlot {
  slot: string;
  fleet?: boolean;
  walStatus?: string;
  active?: boolean;
  retainedBytes?: number | null;
  clientAddr?: string | null;
  state?: string | null;
  replayLagSeconds?: number | null;
  behindBytes?: number | null;
  machine?: string | null;
}

/** One line of the main's Machine logins list (LOGINS_READ_SQL, fleetReplication.ts getFleetReplicationStatus). */
export interface MachineLogin {
  login: string;
  own?: boolean;
  member?: boolean;
  canLogin?: boolean;
  slot?: string | null;
  slotState?: 'active' | 'kept' | 'lost' | 'absent';
  machine?: string | null;
  address?: string | null;
  client?: string | null;
}

export interface ReplicationStatus {
  enabled?: boolean;
  disablingSince?: string;
  publicHost?: string;
  hostPort?: number;
  live?: { sslOn?: boolean; slots?: ReplicationSlot[]; slotWalKeep?: string; logins?: MachineLogin[] };
  reachability?: { ok?: boolean; unchecked?: boolean; error?: string; ageSeconds?: number };
  probeError?: string;
}

/** GET /api/bots/:id/fleet-replication (bots.ts:1832), src/instance/fleetReplication.ts:751. */
export function readReplication(client: Client, botId: string, limitMs: number): Read<{ replication?: ReplicationStatus }> {
  return read(client, `/api/bots/${botId}/fleet-replication`, limitMs);
}

export interface SeedView {
  startedAt?: number;
  phase?: string;
  purpose?: string;
  auto?: boolean;
  cause?: string;
  forSeconds?: number;
  cancelable?: boolean;
  cancelRequested?: boolean;
  lastError?: string;
  safetyDump?: string;
  pinsUnretired?: string[];
}

export interface ReplicaStatus {
  present?: boolean;
  provisioning?: SeedView;
  parkedSeed?: SeedView;
  pinsWarning?: string;
  seedNote?: string;
  seedNoteStartedAt?: number;
  rebuiltShown?: boolean;
  lastError?: string;
  probeError?: string;
  record?: { publicHost?: string; hostPort?: number; primaryHost?: string; primaryPort?: number };
  live?: { running?: boolean; inRecovery?: boolean | null; receiverStatus?: string | null; caughtUp?: boolean | null; replayLagSeconds?: number | null; clockSkewSeconds?: number };
}

export interface ReplicaAnswer {
  replica?: ReplicaStatus | null;
  copyBackup?: BackupFamilyStatus | null;
  join?: { host?: string; port?: number; machine?: string; codeUnreadable?: boolean; addressesError?: string | null } | null;
  rebuild?: { kind?: string | null; text?: string | null; alerts?: Record<string, { outcome?: string | null }>; rebuilt?: string | null } | null;
}

/** GET /api/bots/:id/fleet-replica (bots.ts:1954), src/instance/fleetReplica.ts:417 and fleetCopyWatch.ts:381 and :406. */
export function readReplica(client: Client, botId: string, limitMs: number): Read<ReplicaAnswer> {
  return read(client, `/api/bots/${botId}/fleet-replica`, limitMs);
}

export interface SwitchAnswer {
  lines?: string[];
  takeover?: unknown;
  generation?: { machine?: string; generation?: number; since?: string | null; error?: string } | null;
  /** streamingCopies (fleetSwitch.ts:1774): this main's copies and whether each streams now. */
  copies?: Array<{ slot?: string; machine?: string; streaming?: boolean }>;
}

/** GET /api/bots/:id/fleet-switch (bots.ts:2067), src/instance/fleetSwitch.ts:1652 and :1762. */
export function readSwitch(client: Client, botId: string, limitMs: number): Read<SwitchAnswer> {
  return read(client, `/api/bots/${botId}/fleet-switch`, limitMs);
}

/** How a lane route ended for the screen (laneRoute, bots.ts:2046 to :2064; startLane, fleetSwitch.ts:393). */
export type LaneResult =
  | { kind: 'no-stream'; text: string }
  | { kind: 'lost'; text: string }
  | { kind: 'refused'; text: string }
  | { kind: 'question'; text: string; confirmFlag?: string }
  | { kind: 'done'; text: string; moveCode?: string; file?: string }
  | { kind: 'ended'; ok: boolean; text: string; file?: string }
  | { kind: 'unconfirmed'; text: string };

const limitText = (ms: number) => (ms % 60_000 === 0 ? `${ms / 60_000} min` : ms % 1000 === 0 ? `${ms / 1000} s` : `${ms} ms`);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

export const lanePath = (botId: string, route: string): string => `/api/bots/${botId}/${route}`;

/**
 * One lane route: /ws opens first, the request goes out, and an accepted lane is judged by the bot:switch frame that
 * carries the answer's opId (bots.ts:2040 to :2043). Frames that come before the answer are kept until it names the
 * opId. The request has no time limit; the wait for the frame has `limitMs`.
 */
export async function laneCall(
  client: Client, botId: string, method: string, path: string, body: unknown,
  opts: { op: string; limitMs: number; onAccepted?: () => void },
): Promise<LaneResult> {
  const kept: Array<Record<string, unknown>> = [];
  let onFrame: ((d: Record<string, unknown>) => void) | null = null;
  let onLost: ((reason: string) => void) | null = null;
  let lostWhy: string | null = null;
  const ws: { conn: { close: () => void } | null } = { conn: null };
  const failed = await new Promise<string | null>((resolve) => {
    let opened = false;
    try {
      ws.conn = client.openWs(
        (msg) => {
          const d = msg.data;
          if (msg.type !== 'bot:switch' || !d || typeof d !== 'object' || Array.isArray(d)) return;
          const frame = d as Record<string, unknown>;
          if (frame.id !== botId) return;
          if (onFrame) onFrame(frame);
          else kept.push(frame);
        },
        () => {
          if (opened) return;
          opened = true;
          resolve(null);
        },
        (reason) => {
          if (!opened) {
            opened = true;
            resolve(reason);
            return;
          }
          lostWhy = reason;
          onLost?.(reason);
        },
      );
    } catch (err) {
      resolve(why(err));
    }
  });
  const closeWs = () => {
    try {
      ws.conn?.close();
    } catch {
      // A channel that failed to open has nothing to close.
    }
  };
  if (failed !== null) {
    closeWs();
    return { kind: 'no-stream', text: `The manager's event stream did not open (${failed}), so nothing was sent.` };
  }
  try {
    const r = await call(client, method, path, body);
    if (r.ok !== true) return { kind: 'lost', text: r.text };
    const b = r.value;
    if (b.success !== true) {
      if (b.needsConfirm === true) return { kind: 'question', text: str(b.error), ...(str(b.confirmFlag) ? { confirmFlag: str(b.confirmFlag) } : {}) };
      return { kind: 'refused', text: str(b.error) };
    }
    const opId = str(b.opId);
    if (!opId) return { kind: 'done', text: str(b.text), ...(str(b.moveCode) ? { moveCode: str(b.moveCode) } : {}), ...(str(b.file) ? { file: str(b.file) } : {}) };
    opts.onAccepted?.();
    const unconfirmed = (reason: string): LaneResult => ({
      kind: 'unconfirmed', text: `Can't confirm the ${opts.op}: ${reason}; it may still be running. The Move lines show what stands.`,
    });
    return await new Promise<LaneResult>((resolve) => {
      const judge = (d: Record<string, unknown>) => resolve({ kind: 'ended', ok: d.success === true, text: str(d.text), ...(str(d.file) ? { file: str(d.file) } : {}) });
      const early = kept.find((d) => d.opId === opId);
      if (early) {
        judge(early);
        return;
      }
      if (lostWhy !== null) {
        resolve(unconfirmed(`the event stream closed (${lostWhy})`));
        return;
      }
      const timer = setTimeout(() => resolve(unconfirmed(`no result came within ${limitText(opts.limitMs)}`)), opts.limitMs);
      timer.unref?.();
      onFrame = (d) => {
        if (d.opId !== opId) return;
        clearTimeout(timer);
        judge(d);
      };
      onLost = (reason) => {
        clearTimeout(timer);
        resolve(unconfirmed(`the event stream closed (${reason})`));
      };
    });
  } finally {
    closeWs();
  }
}

/** POST /api/bots/:id/fleet-reseed (bots.ts:2010): `{replaced: true}` answers rejoinComposed (fleetSwitch.ts:1498); a code goes to reseedStalePrimary (fleetReplica.ts:1426). No time limit. */
export function rejoinCopy(client: Client, botId: string, body: { replaced: true } | ProvisionBody): Promise<Outcome<Body>> {
  return call(client, 'POST', `/api/bots/${botId}/fleet-reseed`, body);
}

/** POST /api/bots/:id/fleet-replication (bots.ts:1919): enable or update with a host, or disable; no time limit. */
export function setReplication(
  client: Client, botId: string, body: { enabled: true; publicHost: string; hostPort?: number; slotWalKeepMb?: number } | { enabled: false },
): Promise<Outcome<Body>> {
  return call(client, 'POST', `/api/bots/${botId}/fleet-replication`, body);
}

/** DELETE /api/bots/:id/fleet-replication/slots/:slot (bots.ts:1900), dropFleetSlot (fleetReplication.ts:915). */
export function dropReplicationSlot(client: Client, botId: string, slot: string): Promise<Outcome<Body>> {
  return call(client, 'DELETE', `/api/bots/${botId}/fleet-replication/slots/${encodeURIComponent(slot)}`);
}

/** DELETE /api/bots/:id/fleet-replication/logins/:login (bots.ts:1895), removeCopyLogin: confirm is sent true only after the server's question. */
export function removeMachineLogin(client: Client, botId: string, login: string, confirm: boolean): Promise<Outcome<Body>> {
  return call(client, 'DELETE', `/api/bots/${botId}/fleet-replication/logins/${encodeURIComponent(login)}`, { confirm });
}

/** POST /api/bots/:id/fleet-replication/join-code/renew (bots.ts:1880), renewJoinCode; no time limit. */
export function renewJoinCode(client: Client, botId: string): Promise<Outcome<Body>> {
  return call(client, 'POST', `/api/bots/${botId}/fleet-replication/join-code/renew`, {});
}

/** DELETE /api/bots/:id/fleet-replica/seed (bots.ts:2226), cancelReplicaSeed (fleetReplica.ts:2086). */
export function cancelSeed(
  client: Client, botId: string, body: { startedAt: number; parked: boolean; committed?: boolean; confirm?: boolean },
): Promise<Outcome<Body>> {
  return call(client, 'DELETE', `/api/bots/${botId}/fleet-replica/seed`, body);
}

/** POST /api/bots/:id/fleet-join (bots.ts:1878), joinFleet (src/instance/fleetJoin.ts:722); no time limit. */
export function joinFleet(client: Client, botId: string, joinCode: string): Promise<Outcome<Body>> {
  return call(client, 'POST', `/api/bots/${botId}/fleet-join`, { joinCode });
}

export type ProvisionBody = { joinCode?: string; publicHost?: string; hostPort?: number; confirm?: boolean; confirmVolume?: string };

/** POST /api/bots/:id/fleet-replica (bots.ts:1978), provisionFleetReplica (src/instance/fleetReplica.ts:825); no time limit. */
export function provisionReplica(client: Client, botId: string, body: ProvisionBody): Promise<Outcome<Body>> {
  return call(client, 'POST', `/api/bots/${botId}/fleet-replica`, body);
}

/** DELETE /api/bots/:id/fleet-replica (bots.ts:2198), removeFleetReplica (src/instance/fleetReplica.ts:1215); no time limit. */
export function removeReplica(client: Client, botId: string, body?: { confirmPromoted: true }): Promise<Outcome<Body>> {
  return call(client, 'DELETE', `/api/bots/${botId}/fleet-replica`, body);
}

/** POST /api/bots/:id/fleet-replica/reseed (bots.ts:2270), reseedStandby (src/instance/fleetReplica.ts:2314); no time limit. */
export function reseedCopy(client: Client, botId: string, body: { confirm?: true }): Promise<Outcome<Body>> {
  return call(client, 'POST', `/api/bots/${botId}/fleet-replica/reseed`, body);
}

/** POST /api/bots/:id/fleet-replica/finish-retire (bots.ts:2249), finishPinsRetire (src/instance/fleetReplica.ts:1358); no time limit. */
export function finishRetire(client: Client, botId: string): Promise<Outcome<Body>> {
  return call(client, 'POST', `/api/bots/${botId}/fleet-replica/finish-retire`);
}

/** GET /api/bots/:id/fleet-replication/join-code (bots.ts:1864), getJoinCode (src/instance/fleetReplication.ts:962). */
export function readJoinCode(client: Client, botId: string, limitMs: number): Read<{ joinCode?: string; note?: string }> {
  return read(client, `/api/bots/${botId}/fleet-replication/join-code`, limitMs);
}

export interface MigrateView {
  hidden?: boolean;
  to?: string | null;
  refusal?: string | null;
  destination?: string | null;
  companion?: boolean;
  sharers?: string[];
  record?: MigrateRecordView | null;
  last?: MigrateLastView | null;
  fenced?: boolean;
}

/** GET /api/bots/:id/migrate (bots.ts:542), src/instance/migrate.ts:764. */
export function readMigrate(client: Client, botId: string, limitMs: number): Read<MigrateView> {
  return read(client, `/api/bots/${botId}/migrate`, limitMs);
}

/** POST /api/bots/:id/migrate {to} (bots.ts:556): accepted with an opId no event carries; progress comes as bot:migrate. */
export async function startMigration(client: Client, botId: string, to: string): Promise<Outcome<Body>> {
  const r = await call(client, 'POST', `/api/bots/${botId}/migrate`, { to });
  if (r.ok !== true) return r;
  if (r.value.success !== true) return { ok: false, text: bodyError(r.value, '') };
  return r;
}

export const STATE_WAIT_MS = 5 * 60_000;

/**
 * PUT /api/bots/:id/maintenance {state, message} (bots.ts:571), judged by the bot:maintenance event that carries the
 * request's opId (bots.ts:582): settled is done, not settled is a failure. onAccepted runs once the route accepted.
 */
export async function orderState(
  client: Client,
  bot: Bot,
  state: string,
  message: string,
  waitMs: number,
  onAccepted?: () => void,
): Promise<ActionResult> {
  const name = botName(bot);
  let phase: 'connecting' | 'sent' | 'refused' | 'accepted' = 'connecting';
  let ended = false;
  try {
    const outcome = await waitForEvent(client, { successTypes: ['bot:maintenance'], failTypes: [], timeoutMs: waitMs }, async () => {
      phase = 'sent';
      const r = await call(client, 'PUT', `/api/bots/${bot.id}/maintenance`, { state, message });
      if (r.ok !== true) throw new Error(r.text);
      const b = r.value as { success?: boolean; opId?: unknown; error?: unknown };
      if (ended) throw new Error('the wait had already ended');
      if (b.success !== true) {
        phase = 'refused';
        throw new Error(typeof b.error === 'string' && b.error ? b.error : 'the manager gave no reason');
      }
      phase = 'accepted';
      if (typeof b.opId !== 'string') throw new Error('the manager accepted the change but named no operation to follow');
      onAccepted?.();
      return b.opId;
    }).finally(() => {
      ended = true;
    });
    const d = outcome.event.data as { settled?: unknown; text?: unknown } | null;
    const text = typeof d?.text === 'string' && d.text ? d.text : d?.settled === true ? `The state of ${name} changed.` : `The state change of ${name} did not finish; the manager gave no reason.`;
    return { ok: d?.settled === true, text };
  } catch (err) {
    const reason = why(err);
    if (phase === 'connecting') return { ok: false, text: `Could not reach the manager (${reason}), so the state of ${name} was not changed.` };
    if (phase === 'refused') return { ok: false, text: reason };
    if (phase === 'sent') return { ok: null, text: 'No answer from the manager; the state change may still be running. Check its state before trying again.' };
    const tail = err instanceof WaitTimeoutError ? '; it may still be running' : '';
    return { ok: null, text: `can't confirm the state change of ${name}: ${reason}${tail}.` };
  }
}

export interface BackupConfigAnswer {
  success?: boolean;
  error?: string;
  fleetBackup?: { enabled?: unknown; hour?: unknown } | null;
}

/** PUT /api/bots/:id/fleet-backup-config {enabled?, hour?, expected} (bots.ts:1654): 409 carries the stored settings. */
export async function saveBackupConfig(client: Client, botId: string, body: Record<string, unknown>): Promise<Outcome<BackupConfigAnswer>> {
  const r = await call(client, 'PUT', `/api/bots/${botId}/fleet-backup-config`, body);
  if (r.ok !== true) return r;
  return { ok: true, value: r.value as BackupConfigAnswer };
}

export interface RestorePreview {
  success?: boolean;
  error?: string;
  instances?: Array<{ id: string; displayName: string; running: boolean | null }>;
}

/** GET /api/bots/:id/fleet-backups/restore-preview (bots.ts:1760), previewFleetRestore (fleetBackup.ts:1703). */
export async function readRestorePreview(client: Client, botId: string, limitMs: number): Promise<Outcome<RestorePreview>> {
  const r = await call(client, 'GET', `/api/bots/${botId}/fleet-backups/restore-preview`, undefined, limitMs);
  if (r.ok !== true) return r;
  return { ok: true, value: r.value as RestorePreview };
}

export interface RestoreSteps {
  restored?: boolean;
  preRestoreDump?: string | null;
  guildsRaised?: unknown[];
  claimRaisedTo?: number;
  claimFloor?: number;
  shardClaimsRaised?: number;
  shardClaimsExpired?: number;
  counts?: { result?: string; tables?: number; rows?: number; text?: string } | null;
  botState?: string;
  stopped?: unknown[];
  restarted?: unknown[];
  generation?: number;
}

export interface RestoreAnswer {
  success?: boolean;
  error?: string;
  steps?: RestoreSteps;
  warning?: string;
  note?: string;
}

/** POST /api/bots/:id/fleet-backups/restore {file} (bots.ts:1779): held until the restore ends, so no time limit. */
export async function restoreBackup(client: Client, botId: string, file: string): Promise<Outcome<RestoreAnswer>> {
  const r = await call(client, 'POST', `/api/bots/${botId}/fleet-backups/restore`, { file });
  if (r.ok !== true) return r;
  return { ok: true, value: r.value as RestoreAnswer };
}

/** DELETE /api/bots/:id/fleet-backups/restore-error?at= (bots.ts:1746), dismissShownRestoreNotice (fleetBackup.ts:128). */
export async function dismissRestoreNotice(client: Client, botId: string, at: string): Promise<Outcome<{ success?: boolean; error?: string; dismissed?: boolean }>> {
  const r = await call(client, 'DELETE', `/api/bots/${botId}/fleet-backups/restore-error?at=${encodeURIComponent(at)}`);
  if (r.ok !== true) return r;
  return { ok: true, value: r.value as { success?: boolean; error?: string; dismissed?: boolean } };
}

/** POST /api/bots/:id/fleet-db/decommission (bots.ts:1817), decommissionFleetDb (fleetReplica.ts:1664). */
export async function decommissionDb(client: Client, botId: string): Promise<Outcome<{ success?: boolean; error?: string; dumpFile?: string; warning?: string }>> {
  const r = await call(client, 'POST', `/api/bots/${botId}/fleet-db/decommission`, {});
  if (r.ok !== true) return r;
  return { ok: true, value: r.value as { success?: boolean; error?: string; dumpFile?: string; warning?: string } };
}
