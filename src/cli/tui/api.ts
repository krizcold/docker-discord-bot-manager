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

async function call(client: Client, method: string, path: string, body?: unknown): Promise<Outcome<Body>> {
  let res: CliResponse;
  try {
    res = await client.request(method, path, body === undefined ? {} : { body });
  } catch (err) {
    return { ok: null, text: why(err) };
  }
  const b = res.body as Body | null;
  // The page reads a reply it cannot parse as no answer (index.html:1388): what the manager did is unknown.
  if (!b || typeof b !== 'object') return { ok: null, text: `the reply was not JSON, HTTP ${res.status}` };
  return { ok: true, value: b };
}

const bare = (text: string): string => text.replace(/[.\s]+$/, '');
const failed = (b: Body): boolean => b.success !== true;
const bodyError = (b: Body, fallback: string): string => (typeof b.error === 'string' && b.error ? b.error : fallback);

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
