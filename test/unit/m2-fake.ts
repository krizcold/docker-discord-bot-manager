import type { Client, CliResponse } from '../../src/cli/client';

// Answers shaped as src/webui/routes/sources.ts and bots.ts send them; each row sets the routes it needs.
export type Reply = CliResponse | Error;

export interface Call {
  method: string;
  path: string;
  body: unknown;
}

export interface Fake {
  calls: Call[];
  routes: Map<string, (body: unknown) => Reply | Promise<Reply>>;
  client: Client;
  on: (method: string, path: string, answer: Reply | ((body: unknown) => Reply | Promise<Reply>)) => Fake;
  paths: () => string[];
}

export function ok(body: unknown): CliResponse {
  return { status: 200, ok: true, body };
}

export function refused(status: number, body: unknown): CliResponse {
  return { status, ok: false, body };
}

export const noAnswer = (): Error => new Error('connect ECONNREFUSED 127.0.0.1:8080');

export function fake(): Fake {
  const f: Fake = {
    calls: [],
    routes: new Map(),
    client: undefined as unknown as Client,
    on(method, path, answer) {
      f.routes.set(`${method} ${path}`, typeof answer === 'function' ? answer : () => answer);
      return f;
    },
    paths: () => f.calls.map((c) => `${c.method} ${c.path}`),
  };
  f.client = {
    async request(method: string, path: string, opts: { body?: unknown } = {}): Promise<CliResponse> {
      // Copied as JSON at send time, as the real Client serializes it.
      const body = opts.body === undefined ? undefined : JSON.parse(JSON.stringify(opts.body));
      f.calls.push({ method, path, body });
      const route = f.routes.get(`${method} ${path}`);
      const r = route ? await route(body) : refused(404, { success: false, error: `no route ${method} ${path}` });
      if (r instanceof Error) throw r;
      return r;
    },
  } as unknown as Client;
  return f;
}

// GET /api/bots (bots.ts:153).
export const botList = (bots: unknown[] = []) => ok({ success: true, bots, deploymentMode: 'docker', portBind: { bind: '127.0.0.1', loopback: true } });

// GET /api/sources (sources.ts:29): every source with isCloned added.
export const gitSource = (over: Record<string, unknown> = {}) => ({
  id: 's1', url: 'https://github.com/acme/coolbot.git', branch: 'main', sourceType: 'git', autoUpdate: true,
  lastChecked: '2026-11-14T10:00:00.000Z', lastCommitHash: 'abc1234def', isCloned: true, ...over,
});
export const freshSource = () => gitSource({ id: 's2', url: 'https://github.com/acme/otherbot', lastChecked: null, lastCommitHash: null, isCloned: false });
export const imageSource = () => ({ id: 's3', sourceType: 'docker-image', imageRef: 'ghcr.io/acme/imgbot:1', url: '', branch: '', isCloned: false });
export const sourceList = (sources: unknown[]) => ok({ success: true, sources });

// GET /api/sources/:id/envs (sources.ts:169): buildWizardEnvList rows (DetectedEnvVar plus EnvFieldMeta).
export const envVar = (over: Record<string, unknown>) => ({
  displayLabel: String(over.key), description: '', defaultValue: '', required: false, source: 'env-example', sensitive: false, autoWired: false, ...over,
});
export const repoEnvs = (over: Record<string, unknown> = {}) => ok({
  success: true,
  vars: [
    envVar({ key: 'DISCORD_TOKEN', displayLabel: 'Discord Bot Token', required: true, sensitive: true, defaultValue: 'example-default-token' }),
    envVar({ key: 'CLIENT_ID', displayLabel: 'Discord Client ID' }),
    envVar({ key: 'DATABASE_URL', displayLabel: 'Database URL', autoWired: true }),
  ],
  configFiles: [{ inContainerPath: '/app/config.json', targetName: 'config.json', format: 'json', rawBody: '{\n  "prefix": "!"\n}\n', keys: [], manifest: null, parsed: null }],
  interactiveSetup: null,
  tier2Ran: false,
  hasEnvExample: true,
  sourceScan: null,
  ...over,
});
// A source that is not cloned (sources.ts:209).
export const notClonedEnvs = () => refused(409, { success: false, notCloned: true, error: 'The source repository is not cloned: the last clone failed (exit 128). Fetch or Install the source first.' });

// GET /api/validate-name (bots.ts:2402): resolveNames, checkFolderReuse and envsAvailable.
export const nameOk = (name: string, over: Record<string, unknown> = {}) => ok({
  valid: true, errors: [], displayName: name, sanitizedName: name.toLowerCase().replace(/[^a-z0-9]/g, ''), titleName: name,
  reuseAvailable: false, marker: null, markerUnreadable: false, keptSource: null, sourceMatches: null,
  envsAvailable: false, conflicts: [], adjusted: false, requestedName: name, ...over,
});

export const NAME_PATH = (name: string, source = 's1') => `/api/validate-name?name=${encodeURIComponent(name)}&sourceId=${source}`;
export const RECOVER_PATH = (name: string, source = 's1') => `/api/recover-envs?name=${encodeURIComponent(name)}&sourceId=${source}`;

// POST /api/bots (bots.ts:255): publicBot of the new instance.
export const created = (id = 'b9', name = 'coolbot') => ok({ success: true, bot: { id, displayName: name, sanitizedName: name, sourceId: 's1', status: 'created' } });
// PUT /api/bots/:id/env (bots.ts:1158) and PUT /api/bots/:id/config (bots.ts:1430).
export const envSaved = () => ok({ success: true, removed: [], valid: true, missing: [] });
export const configSaved = () => ok({ success: true, needsUpdate: true, mountsUnknown: false });
