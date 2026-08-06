/**
 * dbm verb registry. Each verb maps 1:1 onto an existing manager route; the CLI
 * holds no business logic. Uncurated or future routes are reachable via `api`.
 */

import { Client, CliResponse } from './client';
import { emit, printJson, fail, table, jsonMode, EXIT_OK, EXIT_ERR, EXIT_TIMEOUT, EXIT_USAGE } from './output';
import { flagStr, flagInt } from './args';
import { waitForEvent, pollUntil } from './waiter';

interface Ctx {
  client: Client;
  args: string[];
  flags: Record<string, string | boolean>;
}

const DEFAULT_WAIT_MS = 120_000;

function need(ctx: Ctx, idx: number, label: string): string {
  const v = ctx.args[idx];
  if (!v) fail(`missing argument: ${label}`, EXIT_USAGE);
  return v as string;
}

function timeoutMs(ctx: Ctx, fallback: number): number {
  const secs = flagInt(ctx.flags, 'timeout', 0);
  return secs > 0 ? secs * 1000 : fallback;
}

async function simple(ctx: Ctx, method: string, path: string, body?: unknown, human?: (b: unknown) => void): Promise<void> {
  const res = await ctx.client.request(method, path, { body });
  emit(res, ctx.flags, human);
}

/** Lifecycle POST that either fires-and-reports or blocks on a terminal WS event. */
async function lifecycle(
  ctx: Ctx,
  id: string,
  path: string,
  successTypes: string[],
  failTypes: string[],
): Promise<void> {
  if (!ctx.flags.wait) {
    return simple(ctx, 'POST', path);
  }
  try {
    const outcome = await waitForEvent(
      ctx.client,
      { successTypes, failTypes, matchId: id, timeoutMs: timeoutMs(ctx, DEFAULT_WAIT_MS) },
      async () => {
        const res = await ctx.client.request('POST', path);
        const b = res.body as { success?: boolean; error?: string } | null;
        if (!res.ok || (b && b.success === false)) throw new Error(b?.error || `HTTP ${res.status}`);
      },
    );
    if (jsonMode(ctx.flags)) printJson({ success: outcome.ok, event: outcome.event });
    else process.stdout.write(`${outcome.event.type}\n`);
    process.exit(outcome.ok ? EXIT_OK : EXIT_ERR);
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err), EXIT_ERR);
  }
}

async function streamSse(ctx: Ctx, path: string): Promise<void> {
  const human = !jsonMode(ctx.flags);
  await ctx.client.sse(
    path,
    (frame) => {
      if (human) process.stdout.write(`${JSON.stringify(frame.data)}\n`);
      else printJson(frame);
    },
    { timeoutMs: ctx.flags.follow ? undefined : timeoutMs(ctx, 0) || undefined },
  );
  process.exit(EXIT_OK);
}

/** Resolve a bot by id, displayName, or sanitizedName; returns the bot record. */
async function resolveBot(ctx: Ctx, idOrName: string): Promise<Record<string, unknown>> {
  const res = await ctx.client.request('GET', '/api/bots');
  const bots = ((res.body as { bots?: Record<string, unknown>[] })?.bots) || [];
  const hit = bots.find((b) => b.id === idOrName || b.displayName === idOrName || b.sanitizedName === idOrName);
  if (!hit) fail(`no bot matching '${idOrName}'`, EXIT_ERR);
  return hit as Record<string, unknown>;
}

type Handler = (ctx: Ctx) => Promise<void>;

const HANDLERS: Record<string, Handler> = {
  // --- sources ---
  'sources list': (c) =>
    simple(c, 'GET', '/api/sources', undefined, (b) =>
      table(((b as { sources?: Record<string, unknown>[] }).sources) || [], ['id', 'composeName', 'url', 'autoUpdate']),
    ),
  'sources add': (c) =>
    simple(c, 'POST', '/api/sources', {
      url: need(c, 0, 'url'),
      ...(flagStr(c.flags, 'name') ? { name: flagStr(c.flags, 'name') } : {}),
      ...(flagStr(c.flags, 'branch') ? { branch: flagStr(c.flags, 'branch') } : {}),
    }),
  'sources info': (c) => simple(c, 'GET', `/api/sources/${need(c, 0, 'id')}`),
  'sources rm': (c) => simple(c, 'DELETE', `/api/sources/${need(c, 0, 'id')}`),
  'sources fetch': (c) => simple(c, 'POST', `/api/sources/${need(c, 0, 'id')}/fetch`),
  'sources envs': (c) =>
    simple(c, 'GET', `/api/sources/${need(c, 0, 'id')}/envs${c.flags.scan ? '?scan=true' : ''}`),

  // --- bots ---
  'bots list': (c) =>
    simple(c, 'GET', '/api/bots', undefined, (b) =>
      table(((b as { bots?: Record<string, unknown>[] }).bots) || [], ['id', 'displayName', 'status', 'hostPort', 'updateAvailable']),
    ),
  'bots info': (c) => simple(c, 'GET', `/api/bots/${need(c, 0, 'id')}`),
  'bots create': async (c) => {
    const image = flagStr(c.flags, 'image');
    const source = flagStr(c.flags, 'source');
    const name = flagStr(c.flags, 'name');
    if (image) {
      if (!name) fail('--name is required with --image', EXIT_USAGE);
      return simple(c, 'POST', '/api/bots', { sourceType: 'docker-image', displayName: name, imageRef: image });
    }
    if (source) return simple(c, 'POST', '/api/bots', { sourceId: source, ...(name ? { displayName: name } : {}) });
    fail('provide --source <id> or --image <ref>', EXIT_USAGE);
  },
  'bots start': (c) => {
    const id = need(c, 0, 'id');
    return lifecycle(c, id, `/api/bots/${id}/start`, ['bot:started'], ['bot:start-failed']);
  },
  'bots stop': (c) => simple(c, 'POST', `/api/bots/${need(c, 0, 'id')}/stop`),
  'bots restart': (c) => {
    const id = need(c, 0, 'id');
    return lifecycle(c, id, `/api/bots/${id}/restart`, ['bot:restarted'], ['bot:restart-failed']);
  },
  'bots build': (c) => {
    const id = need(c, 0, 'id');
    return lifecycle(c, id, `/api/bots/${id}/build`, ['bot:built'], ['bot:build-failed']);
  },
  'bots update': (c) => {
    const id = need(c, 0, 'id');
    return lifecycle(c, id, `/api/bots/${id}/update`, ['bot:rebuilt'], ['bot:pull-failed']);
  },
  'bots delete': (c) => {
    const id = need(c, 0, 'id');
    const q: string[] = [];
    if (c.flags['keep-data']) q.push('keepData=true');
    if (c.flags['no-keep-env']) q.push('keepEnv=false');
    return simple(c, 'DELETE', `/api/bots/${id}${q.length ? '?' + q.join('&') : ''}`);
  },
  'bots check-updates': (c) => simple(c, 'GET', `/api/bots/${need(c, 0, 'id')}/updates`),
  'bots containers': (c) => simple(c, 'GET', `/api/bots/${need(c, 0, 'id')}/containers`),
  'bots stats': (c) => simple(c, 'GET', `/api/bots/${need(c, 0, 'id')}/stats`),
  'bots logs': (c) => simple(c, 'GET', `/api/bots/${need(c, 0, 'id')}/logs?tail=${flagInt(c.flags, 'tail', 100)}`),
  'bots build-logs': (c) => streamSse(c, `/api/bots/${need(c, 0, 'id')}/build-logs`),
  'bots container-logs': (c) =>
    streamSse(c, `/api/bots/${need(c, 0, 'id')}/containers/${need(c, 1, 'container')}/logs/stream?lines=${flagInt(c.flags, 'lines', 50)}`),
  'bots web-auth': (c) => simple(c, 'PUT', `/api/bots/${need(c, 0, 'id')}/web-auth`, { mode: need(c, 1, 'mode') }),
  'bots port': async (c) => {
    const bot = await resolveBot(c, need(c, 0, 'idOrName'));
    if (jsonMode(c.flags)) printJson({ id: bot.id, hostPort: bot.hostPort ?? null, publicUrl: bot.publicUrl ?? null });
    else process.stdout.write(`${bot.hostPort ?? ''}\n`);
    process.exit(bot.hostPort ? EXIT_OK : EXIT_ERR);
  },

  // --- env ---
  'env get': (c) => simple(c, 'GET', `/api/bots/${need(c, 0, 'id')}/env`),
  'env set': (c) => {
    const id = need(c, 0, 'id');
    const vars: Record<string, string> = {};
    for (const pair of c.args.slice(1)) {
      const eq = pair.indexOf('=');
      if (eq < 0) fail(`env pair must be KEY=VALUE: ${pair}`, EXIT_USAGE);
      vars[pair.slice(0, eq)] = pair.slice(eq + 1);
    }
    if (Object.keys(vars).length === 0) fail('provide at least one KEY=VALUE', EXIT_USAGE);
    return simple(c, 'PUT', `/api/bots/${id}/env`, { vars });
  },

  // --- config files ---
  'config get': (c) => simple(c, 'GET', `/api/bots/${need(c, 0, 'id')}/config`),
  'config set': (c) => simple(c, 'PUT', `/api/bots/${need(c, 0, 'id')}/config`, parseBody(c, true)),

  // --- vault ---
  'vault list': (c) => simple(c, 'GET', '/api/vault'),
  'vault values': (c) => simple(c, 'GET', '/api/vault/all-values'),
  'vault set': (c) => simple(c, 'POST', '/api/vault/standalone', { key: need(c, 0, 'key'), value: need(c, 1, 'value') }),
  'vault update': (c) => simple(c, 'PUT', `/api/vault/standalone/${encodeURIComponent(need(c, 0, 'key'))}`, { value: need(c, 1, 'value') }),
  'vault rm': (c) => simple(c, 'DELETE', `/api/vault/standalone/${encodeURIComponent(need(c, 0, 'key'))}`),

  // --- manager ---
  'manager version': (c) => simple(c, 'GET', '/api/manager/version'),
  'manager update': (c) => simple(c, 'POST', '/api/manager/update'),
  deployment: (c) => simple(c, 'GET', '/api/system/deployment'),
  health: (c) => simple(c, 'GET', '/api/health'),

  // --- cross-cutting ---
  api: async (c) => {
    const method = need(c, 0, 'METHOD').toUpperCase();
    const path = need(c, 1, 'path');
    const res: CliResponse = await c.client.request(method, path, { body: parseBody(c, false) });
    emit(res, c.flags);
  },
  events: async (c) => {
    const filter = flagStr(c.flags, 'filter');
    const tmo = timeoutMs(c, 0);
    const conn = c.client.openWs((msg) => {
      if (filter && !msg.type.startsWith(filter)) return;
      process.stdout.write(`${JSON.stringify(msg)}\n`);
    });
    if (tmo > 0) setTimeout(() => { conn.close(); process.exit(EXIT_OK); }, tmo);
  },
  wait: async (c) => {
    const path = flagStr(c.flags, 'get');
    const expr = flagStr(c.flags, 'until');
    if (!path || !expr) fail('wait requires --get <path> and --until <expr>', EXIT_USAGE);
    const result = await pollUntil(c.client, {
      path: path as string,
      expr: expr as string,
      intervalMs: flagInt(c.flags, 'interval', 1000),
      timeoutMs: timeoutMs(c, 60_000),
    });
    printJson(result.body);
    process.exit(result.ok ? EXIT_OK : EXIT_TIMEOUT);
  },
};

function parseBody(ctx: Ctx, required: boolean): unknown {
  const raw = flagStr(ctx.flags, 'body');
  if (raw === undefined) {
    if (required) fail('--body <json> is required', EXIT_USAGE);
    return undefined;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return fail('--body must be valid JSON', EXIT_USAGE);
  }
}

export async function dispatch(client: Client, positionals: string[], flags: Record<string, string | boolean>): Promise<void> {
  const two = positionals.slice(0, 2).join(' ');
  const one = positionals[0] || '';
  const handler = HANDLERS[two] || HANDLERS[one];
  if (!handler) fail(`unknown command: ${positionals.join(' ') || '(none)'} (try 'dbm --help')`, EXIT_USAGE);
  const consumed = HANDLERS[two] ? 2 : 1;
  await handler({ client, args: positionals.slice(consumed), flags });
}

export const COMMAND_NAMES = Object.keys(HANDLERS);
