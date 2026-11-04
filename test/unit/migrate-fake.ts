// A scripted contract 9 bot and the collaborators of migrate.ts, for the nm10 lane files. Each test file mocks the
// modules with the factories below; `m` holds the state a row sets and the effects it reads back.
type Result = { ok: boolean; status?: number; body?: any; error?: string; unknown?: boolean };
/** A queue entry; a function is called when its turn comes, and the row settles the promise it returns (the hook mock awaits it). */
type QueueEntry = Result | null | (() => Result | Promise<Result>);
/** fact: contract 9's S0 class of a finished or stopped job (1 done, 2 past the switch and settled done, 3 not retired, 4 can't confirm). */
export type FakeJob = { jobId: string; to: 'postgres' | 'file'; state: string; stage: string; destination?: unknown; error?: string; leftOut?: unknown[]; fact?: 1 | 2 | 3 | 4; dest?: unknown };
export type KillPoint = { at: string; nth?: number; when: 'before' | 'after' };

export const SMDB = 'https://github.com/x/fully-modular-discord-bot';
export const FLEET_DB = { containerName: 'b1-fleet-postgres', user: 'smdb', db: 'smdb', volume: 'b1-fleet-postgres-data' };
export const COMPANION_URL = 'postgresql://smdb:pw@b1-fleet-postgres:5432/smdb';
export const EXTERNAL_URL = 'postgresql://u:secret@db.example.test:5432/app';
export const SETTLED = { state: 'maintenance', message: 'Back soon', orderedAt: '2026-10-30T00:00:00.000Z', settled: true, hook: 'confirmed', login: 'blocked', savedByBot: 'maintenance' };

/** Section 9's form clauses (round 5): what the address does, then what to write instead. */
export const URL_FORM_CLAUSE: Record<string, [string, string]> = {
  hosts: ['lists several hosts in one address, separated by commas', 'write one host in each postgresql:// address'],
  scheme: ['holds an address that does not start with postgresql:// or postgres://', 'write it as postgresql://user:password@host:port/database'],
  unparsed: ['holds a postgresql:// address the manager cannot parse', 'write it as postgresql://user:password@host:port/database'],
  param: ['has a host, hostaddr or port parameter after the ?, which the driver uses in place of the host and port before it', 'write the host and port before the database name and remove that parameter'],
  encodedHost: ['has % codes in its host, which the driver decodes', 'write the host without % codes'],
  noHost: ['names no host', 'write the host after the @'],
  noDatabase: ['names no database, so the driver takes the database name from its PGDATABASE setting or the user name', 'end the address with /database'],
  databaseName: ['has a % or a / in the database name', 'write the database name without them'],
  pgport: ["names no port while the bot's PGPORT setting is set, which the driver uses in its place", 'write the port after the host, as in host:5432'],
};
export const MG_URL_FORM = (form: string) => `The Database URL ${URL_FORM_CLAUSE[form][0]}, so the manager can't tell which database the bot's Postgres driver connects to; ${URL_FORM_CLAUSE[form][1]}; nothing was saved`;
export const MG_URL_FORM_A = (form: string) => `The Database URL ${URL_FORM_CLAUSE[form][0]}, so the manager can't tell which database the bot's Postgres driver connects to, and the migration was refused; ${URL_FORM_CLAUSE[form][1]}; nothing was changed`;
/** Section 9's round 6 texts. */
export const MG_P_FENCE = "Closing the bot's database to every connection but this bot's and the manager's";
export const MG_FENCE_F = (why: string, again = false) => `The migration closed before its copy: ${again ? "after the bot's restart into maintenance, the manager could not close the bot's database to other connections again" : "the manager could not close the bot's database to other connections"} (${why}), and a move to JSON files renames that database's data aside, which a bot or program the manager cannot see may be using. Nothing was copied, and the bot stays in Maintenance.`;
/** Section 9's round 9 MG-FENCE-WAIT: the renewal form; a null jobId names no job. */
export const MG_FENCE_SOME = " The manager can't confirm whether the database admits other connections meanwhile: any lines written to its pg_hba.conf before the failure stay there, refusing every connection but this bot's and the manager's, until the migration ends or a press of Migrate writes them again.";
export const MG_FENCE_WAIT = (jobId: string | null, why: string) => {
  const so = jobId === null ? 'so it did not ask the bot to start the migration again' : `so it did not go on following migration ${jobId}`;
  return `The manager could not renew the lines that close the bot's database to every connection but this bot's and the manager's (${why}), ${so}. The bot stays in Maintenance with the migration open; press Migrate to try again.`;
};
/** Section 9's round 8 texts. */
export const MG_NOT_AGAIN = (clause: string, retry?: string) => `The manager did not ask the bot to start the migration again: ${clause}. The bot stays in Maintenance with the migration open; ${retry ?? 'press Migrate to try again'}.`;
export const MG_SHARER_STILL_C = (name: string) => `${name} uses the same database, and docker still shows its container running after the manager stopped it`;
export const MG_SHARER_STILL = (name: string) => `The migration did not start: ${MG_SHARER_STILL_C(name)}. Nothing was copied, and the bot stays in Maintenance; press Migrate to stop it again.`;
export const MG_P_OPEN = (names: string[], repl: string[] = []) => (names.length ? `Following the move the bot was already running, with its database open to other connections; ${names.join(', ')} ${names.length === 1 ? 'uses it, and the manager does not stop it' : 'use it, and the manager does not stop them'}${repl.map(n => `; ${n}'s own managed database has replication on, so this migration does not hold ${n}, and the manager can still start, update or build it`).join('')}` : 'Following the move the bot was already running, with its database open to other connections');
export const MG_DONE_OPEN = " The bot started this copy itself, and the database stayed open to other connections while it copied; the manager can't confirm that no other bot or program wrote to the database during the copy.";
export const MG_DONE_UNSURE = " The bot started this copy itself, and the manager's step that stops the other bots on the database and closes it to other connections had begun on this migration without finishing; the manager can't confirm whether the database was closed during the copy, or that no other bot or program wrote to it.";
const oneBot = (names: string) => !names.includes(', ');
export const MG_SHARERS_STAY = (names: string) => oneBot(names) ? ` ${names} uses the old database and stays stopped: its data is renamed aside, so that bot cannot load it.` : ` ${names} use the old database and stay stopped: its data is renamed aside, so they cannot load it.`;
export const MG_SHARERS_RUN = (names: string) => oneBot(names) ? ` ${names} uses the old database and runs: its data is renamed aside, so that bot cannot load it, and that bot's writes to it fail.` : ` ${names} use the old database and run: its data is renamed aside, so they cannot load it, and their writes to it fail.`;
export const MG_SHARERS_UNSURE = (names: string) => oneBot(names) ? ` ${names} uses the old database, and docker did not say whether it runs: its data is renamed aside, so that bot cannot load it.` : ` ${names} use the old database, and docker did not say whether they run: its data is renamed aside, so they cannot load it.`;
export const MG_DB_START = (err: string) => `The migration did not start: the managed database did not start (${err}). Nothing was copied, and the bot stays in Maintenance.`;
export const MG_FENCE_UNCONFIRMED = " The manager can't confirm that the database admits other connections again: its pg_hba.conf holds none of the lines the migration adds, but no reload of the file reached the database, which may still apply lines an earlier attempt removed from the file until it reloads its configuration or its container restarts.";
export const MG_WHY_DB_DOWN = (state: 'restarting' | 'stopped' | null) => (state === 'restarting' ? "docker shows the bot's managed database restarting after its start"
  : state === 'stopped' ? "docker shows the bot's managed database stopped after its start" : "docker did not say whether the bot's managed database runs after its start");
export const MG_FENCE_WAIT_SUBS = (n: number) => `the database has ${n} enabled subscription(s), whose workers write past the fence; disable them (ALTER SUBSCRIPTION ... DISABLE) and retry`;
export const MG_FENCE_BACK = (why: string) => ` The lines the migration added to the database's pg_hba.conf, which refuse every connection but this bot's and the manager's, could not be removed (${why}), so the migration stays open; press Migrate to remove them again.`;
export const MG_FENCE_BACK_G = (jobId: string, dest: string, why: string) => `Migration ${jobId} moved the data to ${dest}, but the lines it added to the database's pg_hba.conf, which refuse every connection but this bot's and the manager's, could not be removed (${why}). The bot stays in Maintenance; press Migrate to remove them and go on.`;
export const MG_FENCE_STRIPPED = " The lines the migration added to the database's pg_hba.conf are removed from the file, but the database has not reloaded it, so until it reloads its configuration or its container restarts it may go on refusing every connection but the bot container's as it was during the migration: other bots' connections, and the bot's own after a start that gives its container another address.";
export const MG_WHY_RESTARTING = "docker shows that database restarting, so the manager can't confirm whether it is READ-ONLY";
export const WHY_LIFT_LOCKED = (detail: string) => `docker could not change the file in the database container or in its volume (${detail})`;
export const DOWN_F_R = (err: string) => ` The manager can't confirm that the bot's database login, which the migration opened, is blocked again: docker shows the managed database restarting, and it did not accept connections (${err}). Once the database runs, the manager's maintenance check blocks the login while the bot's state is not Running.`;
export const DOWN_P_R = (err: string) => ` The manager can't confirm that the login of the bot's managed database, which the migration opened, is blocked again: docker shows that database restarting, and it did not accept connections (${err}). The bot keeps its data in its JSON files, which do not use that login; a later migration to Postgres uses the login as it is.`;
export const MG_FLEET_REPL_ON = "This bot's managed database has replication on, and the manager's check of it as the fleet's main database pauses while a migration of this bot is open, so the migration was refused; turn replication off first; nothing was changed";

export interface MigrateFake {
  bots: Record<string, any>;
  env: Record<string, Record<string, string>>;
  envStatus: { corrupt: boolean; undecryptable: string[] };
  lock: Record<string, string>;
  shuttingDown: boolean;
  hold: boolean;
  deleteLane: boolean;
  app: Record<string, boolean | null>;
  sidecar: Record<string, boolean | null | 'restarting'>;
  login: { inRecovery: boolean; canLogin: boolean | null; sessions: number };
  loginReadFail: string | null;
  openResult: { ok: boolean; cls?: string; error?: string };
  openSticks: boolean;
  blockResult: { ok: boolean; cls?: string; error?: string };
  fence: any;
  events: string[];
  migrateWrites: any[];
  failMigrateWrite: (n: number, rec: any) => string | null;
  failUpdateBot: string | null;
  ensure: (() => any) | null;
  attach: { success: boolean; error?: string };
  dbStart: { success: boolean; error?: string };
  dbReady: boolean;
  stop: { success: boolean; error?: string };
  start: { success: boolean; error?: string; notApplied?: string[] } | ((id: string) => { success: boolean; error?: string; notApplied?: string[] });
  sharerStop: { success: boolean; error?: string } | ((id: string, opts?: { seen?: boolean }) => { success: boolean; error?: string });
  sharerStopOpts: any[];
  sharerStart: { success: boolean; error?: string } | ((id: string) => { success: boolean; error?: string });
  containerEnv: { ok: true; env: Record<string, string> } | { ok: false; error: string } | null;
  order: { settled: boolean; text: string } | { refused: true; error: string };
  saveAnswers: Array<Result | (() => Result)>;
  held: any[];
  notice: string | null;
  notices: Record<string, string | null>;
  seed: any;
  seeds: Record<string, any>;
  kill: KillPoint | null;
  killSeen: number;
  postAt: number[];
  tickOn: string | null;
  sharers: string[];
  liveSharers: string[];
  fenceUp: string | null | ((refresh: boolean) => string | null);
  fenceLift: 'lifted' | 'stripped' | 'unconfirmed' | 'gone' | 'unknown' | 'locked';
  bot: {
    journal: FakeJob[];
    script: Array<Partial<FakeJob>>;
    postQueue: Array<QueueEntry>;
    getQueue: Array<QueueEntry>;
    posts: any[];
    gets: number;
    down: boolean;
    destination: unknown;
    checks: Array<Check | (() => Check)>;
    unreadable: string | null;
  };
  listener: Array<{ id: string; text: string; final: boolean }>;
}

const g = globalThis as { __migrateFake?: MigrateFake };
export const m: MigrateFake = (g.__migrateFake ??= fresh());

function fresh(): MigrateFake {
  return {
    bots: {}, env: {}, envStatus: { corrupt: false, undecryptable: [] }, lock: {}, shuttingDown: false, hold: false, deleteLane: false,
    app: {}, sidecar: {}, login: { inRecovery: false, canLogin: false, sessions: 0 }, loginReadFail: null,
    openResult: { ok: true }, openSticks: true, blockResult: { ok: true }, fence: { ok: true, on: false },
    events: [], migrateWrites: [], failMigrateWrite: () => null, failUpdateBot: null, ensure: null,
    attach: { success: true }, dbStart: { success: true }, dbReady: true, stop: { success: true }, start: { success: true },
    sharerStop: { success: true }, sharerStopOpts: [] as any[], sharerStart: { success: true }, containerEnv: null,
    order: { settled: true, text: 'The bot is running normally.' }, saveAnswers: [], held: [], notice: null, notices: {}, seed: null, seeds: {}, tickOn: null, sharers: [], liveSharers: [] as string[],
    fenceUp: null as string | null | ((refresh: boolean) => string | null), fenceLift: 'lifted' as 'lifted' | 'stripped' | 'unconfirmed' | 'gone' | 'unknown' | 'locked',
    kill: null, killSeen: 0, postAt: [],
    bot: { journal: [], script: [{ stage: 'copying' }, { state: 'done', stage: 'switching' }], postQueue: [], getQueue: [], posts: [], gets: 0, down: false, destination: undefined, checks: [], unreadable: null },
    listener: [],
  };
}

export function resetMigrate(over: Partial<MigrateFake> = {}): void {
  Object.assign(m, fresh(), over);
}

const clone = <T>(v: T): T => (v === undefined ? v : JSON.parse(JSON.stringify(v)));

/** A manager restart: memory goes (the op locks, the kill point, the shutdown flag); the row then calls resumeMigrations(). */
export function restart(): void {
  m.lock = {};
  m.kill = null;
  m.killSeen = 0;
  m.shuttingDown = false;
}

/** Runs an effect through the kill point: at its nth match the effect never settles, and with `before` it does not happen. */
async function effect<T>(name: string, fn: () => T | Promise<T>): Promise<T> {
  const k = m.kill;
  const hit = !!k && name.startsWith(k.at) && ++m.killSeen === (k.nth ?? 1);
  if (hit && k!.when === 'before') return new Promise<T>(() => {});
  const r = await fn();
  if (hit) return new Promise<T>(() => {});
  return r;
}

/** A JSON bot in settled Maintenance (or a Postgres bot on its companion with `postgres: true`). */
export function seedBot(opts: { postgres?: boolean; external?: boolean; url?: string; inst?: Record<string, unknown>; env?: Record<string, string> } = {}): void {
  const inst: any = { id: 'b1', displayName: 'B1', sanitizedName: 'b1', sourceUrl: SMDB, envVars: {}, status: 'running', createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z', maintenance: { ...SETTLED }, updateToken: 't', ...opts.inst };
  let env: Record<string, string> = { DATA_BACKEND: 'file' };
  if (opts.postgres) { inst.fleetDb = { ...FLEET_DB }; env = { DATA_BACKEND: 'postgres', DATA_BACKEND_URL: COMPANION_URL }; m.login = { inRecovery: false, canLogin: false, sessions: 0 }; }
  if (opts.external) env = { DATA_BACKEND: 'postgres', DATA_BACKEND_URL: EXTERNAL_URL };
  if (opts.url !== undefined) env.DATA_BACKEND_URL = opts.url;
  m.bots[inst.id] = inst;
  m.env[inst.id] = { ...env, ...opts.env };
  m.app[inst.id] = true;
  if (!opts.postgres) m.login = { inRecovery: false, canLogin: true, sessions: 0 };
}

const ok = (body: any): Result => ({ ok: true, status: 200, body: { success: true, ...body } });
export const refusal = (error: string, status = 409): Result => ({ ok: false, status, body: { success: false, error }, error });
export const noAnswer = (error = 'migrate unreachable: connect ECONNREFUSED'): Result => ({ ok: false, error });
export const unknownPost = (): Result => ({ ok: false, unknown: true, error: 'migrate sent, no answer within 30 s' });
export const http = (status: number, body: any = null): Result => ({ ok: false, status, body, error: body?.error || `migrate returned ${status}` });
export const getJob = (job: Partial<FakeJob> | null): Result => ok({ job: job ? { startedAt: '2026-10-31T00:00:00.000Z', stage: 'checking', ...job } : null });
export const postJob = (job: Partial<FakeJob>): Result => ok({ stage: 'checking', ...job });
/** The bot's recognition guard when /data/.migration.json is unreadable. */
export const UNREADABLE = "can't confirm which store holds the data: /data/.migration.json does not hold a job id, a direction and a stage";
const view = ({ fact, dest, ...j }: FakeJob) => j;
/** S2's session refusal: the jobs whose sessions linger and the bot sessions, built as the bot builds it from its last job. */
export type SessionCheck = { sessions: string[]; bots?: number };
type Check = string | SessionCheck;

function sessionText(c: SessionCheck, lastJobId: string | null): string {
  const parts: string[] = [];
  if (c.bots) parts.push(`${c.bots} other session(s) of the bot's database role are connected (smdb-bot: ${c.bots}); stop every bot on this database first`);
  for (const id of c.sessions) {
    parts.push(id === lastJobId
      ? `Migration ${id}'s database session is still open; the database ends it once it notices the connection is gone; run the migration again once it no longer shows`
      : `Migration ${id}, which is not this bot's last one, holds a session on this database; run this migration once it no longer shows`);
  }
  return parts.join('. ');
}

function current(): FakeJob | null {
  return m.bot.journal.length ? m.bot.journal[m.bot.journal.length - 1] : null;
}

function identity(url: string | undefined): unknown {
  if (!url) return undefined;
  try {
    const u = new URL(url);
    return { host: u.hostname, port: Number(u.port || 5432), database: u.pathname.slice(1) };
  } catch {
    return undefined;
  }
}

/** The S0 class of the last job: its fact, else 1 when done, 2 for a move to file at `switching`, else 3. */
function factOf(job: FakeJob): 1 | 2 | 3 | 4 {
  if (job.fact) return job.fact;
  if (job.state === 'done') return 1;
  if (job.to === 'file' && job.stage === 'switching') return 2;
  return 3;
}

function startJob(inst: any, body: { jobId: string; to: 'postgres' | 'file'; url?: string }): Result {
  const url = body.url ?? (inst?.id ? m.env[inst.id]?.DATA_BACKEND_URL : undefined);
  const job: FakeJob = { jobId: body.jobId, to: body.to, state: 'running', stage: 'checking', ...(body.to === 'postgres' ? { dest: m.bot.destination ?? identity(url) } : {}) };
  if (m.bot.checks.length) {
    const f = m.bot.checks.shift()!;
    const c = typeof f === 'function' ? f() : f;
    Object.assign(job, { state: 'failed', error: typeof c === 'string' ? c : sessionText(c, current()?.jobId ?? null) });
  }
  m.bot.journal.push(job);
  return ok({ jobId: job.jobId, to: job.to, state: 'started', stage: 'checking' });
}

/** Contract 9's POST in NB3's S0 order, as the bot answers it. */
export function botPost(inst: any, body: { jobId: string; to: 'postgres' | 'file'; url?: string }): Result {
  m.bot.posts.push(clone(body));
  m.postAt.push(Date.now());
  if (m.bot.postQueue.length) {
    const q = m.bot.postQueue.shift();
    if (q) return (typeof q === 'function' ? q() : q) as Result;
  }
  if (m.bot.down) return noAnswer();
  const cur = current();
  if (cur && cur.state === 'running') {
    if (cur.to === body.to) return ok({ jobId: cur.jobId, to: cur.to, state: 'running' });
    const error = `Migration ${cur.jobId} (--to ${cur.to}) is running`;
    return { ...refusal(error), body: { success: false, error, jobId: cur.jobId, to: cur.to } };
  }
  if (m.bot.unreadable) return refusal(m.bot.unreadable);
  if (cur && cur.to === body.to) {
    const fact = factOf(cur);
    if (fact === 1) return postJob({ ...view(cur), state: 'done' });
    if (fact === 2) {
      Object.assign(cur, { state: 'done', fact: 1 });
      return postJob(view(cur));
    }
    if (fact === 4) {
      const error = `can't confirm; the marker /data/.backend.json names ${cur.to} under no migration, not migration ${cur.jobId}`;
      return { ...refusal(error), body: { success: false, error, jobId: cur.jobId, to: cur.to } };
    }
    if (cur.state !== 'failed') Object.assign(cur, { state: 'failed', error: 'The old store was not retired; nothing was switched' });
    return startJob(inst, body);
  }
  if (cur && cur.jobId === body.jobId) return ok({ jobId: cur.jobId, to: cur.to, state: cur.state, stage: cur.stage, ...(cur.error !== undefined ? { error: cur.error } : {}) });
  return startJob(inst, body);
}

/** Contract 9's GET: each GET applies the next script step to a running job. */
export function botGet(): Result {
  m.bot.gets++;
  if (m.bot.getQueue.length) {
    const q = m.bot.getQueue.shift();
    if (q) return (typeof q === 'function' ? q() : q) as Result;
  }
  if (m.bot.down) return noAnswer();
  if (m.bot.unreadable) return refusal(m.bot.unreadable, 200);
  const cur = current();
  if (cur && cur.state === 'running' && m.bot.script.length) Object.assign(cur, m.bot.script.shift());
  if (cur && cur.dest !== undefined && cur.destination === undefined && !['checking', 'draining', 'reading'].includes(cur.stage)) cur.destination = cur.dest;
  return getJob(cur ? view(cur) : null);
}

// ─── Mock factories ───

export function cmMock(): Record<string, unknown> {
  const bot = (id: string) => (m.bots[id] ? clone(m.bots[id]) : null);
  const withLock = async (id: string, op: string, fn: () => Promise<unknown>) => {
    if (m.lock[id]) throw new Error(`Operation '${m.lock[id]}' is already in progress for this bot`);
    m.lock[id] = op;
    try { return await fn(); } finally { delete m.lock[id]; }
  };
  const startResult = (id: string) => (typeof m.start === 'function' ? m.start(id) : m.start);
  return {
    SHUTDOWN_REFUSAL: 'The manager is shutting down',
    MIGRATE_GATE: { needsBuild: "the bot's image or compose is missing, and a build in the middle of a migration would rewrite the compose, so the manager did not build it" },
    isShuttingDown: () => m.shuttingDown,
    registryFault: () => null,
    getBot: bot,
    getAllBots: () => Object.keys(m.bots).map(bot),
    isBotBusy: (id: string) => m.lock[id] ?? null,
    migrationHolds: (id: string) => {
      const out: any[] = [];
      for (const other of Object.values(m.bots)) {
        const rec = other.migrate;
        if (!rec || other.id === id) continue;
        if (rec.sharers?.includes(id)) out.push({ other: clone(other), rec: clone(rec) });
      }
      return out;
    },
    databaseHostOf: (address: string) => {
      let host = '';
      let port = 5432;
      const s = String(address ?? '').trim();
      if (/^postgres(ql)?:\/\//i.test(s)) {
        try { const u = new URL(s); host = u.hostname; port = Number(u.port || 5432); } catch { return null; }
      } else {
        const mm = /^(\[[^\]]+\]|[^:/]+)(?::(\d*))?(?:\/|$)/.exec(s);
        if (!mm) return null;
        host = mm[1];
        port = Number(mm[2] || 5432);
      }
      host = host.replace(/^\[|\]$/g, '').toLowerCase();
      if (!host) return null;
      const found = Object.values(m.bots).find((b: any) => b.fleetDb?.containerName?.toLowerCase() === host
        || (b.fleetDb?.replication && String(b.fleetDb.replication.publicHost).replace(/^\[|\]$/g, '').toLowerCase() === host && b.fleetDb.replication.hostPort === port));
      return found ? clone(found) : null;
    },
    scrubbedRecordText: (_id: string, text: string) => text,
    databaseHoldRefusal: (_id: string, action: string) => (m.hold ? { success: false, error: `A fleet restore is running on this instance's database; ${action} is refused until it ends` } : null),
    deleteLaneRefusal: (_id: string, action: string) => (m.deleteLane ? { success: false, error: `A Delete of this instance did not finish; ${action} is refused until Delete is run again` } : null),
    unfinishedRetireRefusal: (at: string) => `The fleet database of this instance was being removed (since ${at})`,
    withExternalBotOp: withLock,
    updateInstanceMigrate: (id: string, rec: any, last?: any) => {
      const n = m.migrateWrites.length + 1;
      const err = m.failMigrateWrite(n, rec);
      if (err) throw new Error(err);
      m.migrateWrites.push(clone({ rec, last }));
      if (rec) m.bots[id].migrate = clone(rec);
      else delete m.bots[id].migrate;
      if (last !== undefined) m.bots[id].migrateLast = clone(last);
      m.events.push(rec ? `record:${rec.phase}${rec.finishing ? `:${rec.finishing}` : ''}` : 'record:closed');
    },
    updateBot: async (id: string, update: any) => {
      if (m.failUpdateBot) throw new Error(m.failUpdateBot);
      m.events.push(`env:${JSON.stringify(update.envVars)}`);
      m.env[id] = { ...m.env[id], ...update.envVars };
      return bot(id);
    },
    updateBotInOp: (id: string, update: any, op: string) => effect(`env-inop:${JSON.stringify(update.envVars)}`, () => {
      if (m.lock[id] !== op) throw new Error(`the update must run under the '${op}' operation, which is not held`);
      if (m.failUpdateBot) throw new Error(m.failUpdateBot);
      m.events.push(`env-inop:${JSON.stringify(update.envVars)}`);
      m.env[id] = { ...m.env[id], ...update.envVars };
      return bot(id);
    }),
    ensureFleetDataBackend: (inst: any, opts: any) => {
      m.events.push(`ensure${opts?.forMigrate ? ':forMigrate' : ''}`);
      if (m.ensure) return m.ensure();
      if (!m.env[inst.id].DATA_BACKEND_URL) m.env[inst.id].DATA_BACKEND_URL = COMPANION_URL;
      if (!m.bots[inst.id].fleetDb) m.bots[inst.id].fleetDb = { ...FLEET_DB };
      return { ...FLEET_DB, password: 'pw' };
    },
    attachFleetDbService: () => effect('attach', () => { m.events.push('attach'); return m.attach; }),
    startFleetDbSidecar: (id: string) => effect(`db-start:${id}`, () => {
      m.events.push(`db-start:${id}`);
      if (m.dbStart.success) {
        const c = m.bots[id]?.fleetDb?.containerName;
        if (c) m.sidecar[c] = true;
      }
      return m.dbStart;
    }),
    databaseReady: (db: any) => effect(`db-ready:${db.containerName}`, () => { m.events.push(`db-ready:${db.containerName}`); return m.sidecar[db.containerName] === 'restarting' ? false : m.dbReady; }),
    appContainerRunning: async (id: string) => (id in m.app ? m.app[id] : false),
    stopBotInOp: (id: string, op: string) => effect(`stop:${op}`, () => {
      m.events.push(`stop:${op}`);
      if (m.stop.success) m.app[id] = false;
      return m.stop;
    }),
    startBotInOp: (id: string, op: string) => effect(`start:${op}`, () => {
      m.events.push(`start:${op}`);
      const r = startResult(id);
      if (r.success) m.app[id] = true;
      return r;
    }),
    stopBot: (id: string, opts?: { seen?: boolean }) => effect(`stop-sharer:${id}`, () => {
      m.events.push(`stop-sharer:${id}`);
      m.sharerStopOpts.push(opts ?? null);
      if (m.lock[id]) throw new Error(`Operation '${m.lock[id]}' is already in progress for this bot`);
      const r = typeof m.sharerStop === 'function' ? m.sharerStop(id, opts) : m.sharerStop;
      if (r.success) m.app[id] = false;
      return r;
    }),
    startBot: (id: string) => effect(`start-sharer:${id}`, () => {
      m.events.push(`start-sharer:${id}`);
      if (m.lock[id]) throw new Error(`Operation '${m.lock[id]}' is already in progress for this bot`);
      const r = typeof m.sharerStart === 'function' ? m.sharerStart(id) : m.sharerStart;
      if (r.success) m.app[id] = true;
      return r;
    }),
    appContainerEnv: (id: string) => effect('env-read', () => {
      m.events.push('env-read');
      if (m.containerEnv) return m.containerEnv;
      return { ok: true, env: { DATA_BACKEND: m.env[id].DATA_BACKEND, DATA_BACKEND_URL: m.env[id].DATA_BACKEND_URL ?? '' } };
    }),
  };
}

export function envMock(real: any): Record<string, unknown> {
  return {
    ...real,
    getEnvVarsWithStatus: (id: string) => ({ vars: { ...(m.env[id] || {}) }, undecryptable: [...m.envStatus.undecryptable], encrypted: [], corrupt: m.envStatus.corrupt }),
    getEnvVars: (id: string) => ({ ...(m.env[id] || {}) }),
  };
}

/** docker exec on a stopped container fails; the login calls answer as it does. */
const DOWN = { ok: false, cls: 'other', error: 'container is not running' };
const stoppedAt = (t: any) => !!t?.container && m.sidecar[t.container] === false;
/** docker's own answer to an exec on a container its restart policy loops (D102). */
export const RESTARTING = (c: string) => ({ ok: false, cls: 'other', error: `Container ${c} is restarting, wait until the container is running` });
const restartingAt = (t: any) => !!t?.container && m.sidecar[t.container] === 'restarting';

export function dbLoginMock(real: any): Record<string, unknown> {
  return {
    ...real,
    sidecarRunning: async (c: string) => { const s = c in m.sidecar ? m.sidecar[c] : true; return s === 'restarting' ? true : s; },
    sidecarState: async (c: string) => { const s = c in m.sidecar ? m.sidecar[c] : true; return s === null ? null : s === 'restarting' ? 'restarting' : s === false ? 'stopped' : 'running'; },
    readWriteFence: async (t: any) => (restartingAt(t) ? RESTARTING(t.container) : m.fence),
    readBotLogin: (t: any) => effect('login-read', () => { m.events.push('login-read'); if (restartingAt(t)) return RESTARTING(t.container); if (stoppedAt(t)) return DOWN; return m.loginReadFail ? { ok: false, cls: 'other', error: m.loginReadFail } : { ok: true, login: { ...m.login } }; }),
    openBotLogin: () => effect('login-open', () => { m.events.push('login-open'); if (m.openResult.ok && m.openSticks) m.login.canLogin = true; return m.openResult; }),
    blockBotLogin: (t: any) => effect('login-block', () => { m.events.push('login-block'); if (restartingAt(t)) return RESTARTING(t.container); if (stoppedAt(t)) return DOWN; if (m.blockResult.ok) m.login.canLogin = false; return m.blockResult; }),
    endBotSessions: (t: any) => effect('login-end', () => { m.events.push('login-end'); if (restartingAt(t)) return RESTARTING(t.container); if (stoppedAt(t)) return DOWN; m.login.sessions = 0; return { ok: true }; }),
    ensureManagerDbRole: async () => ({ ok: true }),
  };
}

export function hookMock(real: any): Record<string, unknown> {
  return {
    ...real,
    callAppHook: (inst: unknown, action: string, method: string, body: any) => {
      if (action === 'maintenance') {
        return effect('hook:maintenance', () => {
          m.events.push('hook:maintenance');
          const a: any = m.saveAnswers.length ? m.saveAnswers.shift() : { ok: true, status: 200, body: { success: true, saved: true } };
          return typeof a === 'function' ? a() : a;
        });
      }
      if (action !== 'migrate') return Promise.resolve({ ok: true, status: 200, body: { success: true } });
      const name = method === 'POST' ? `POST:${body.jobId}` : 'GET';
      return effect(name, () => {
        m.events.push(name);
        return method === 'POST' ? botPost(inst, body) : botGet();
      });
    },
  };
}

export function maintenanceMock(real: any): Record<string, unknown> {
  return {
    ...real,
    recordHeld: (_id: string, held: any) => { m.held.push(held); },
    runOrderInOp: (_id: string, to: string, _msg: string, op: string) => effect(`order:${to}:${op}`, () => { m.events.push(`order:${to}:${op}`); return m.order; }),
  };
}

/** The migration's pg_hba fence (D96): `m.fenceUp` answers the write (null when it stands), `m.fenceLift` the lift. */
export function fenceMock(): Record<string, unknown> {
  return {
    fenceMigrateSource: (inst: any, _owner: string, opts?: { refresh?: boolean }) => effect(opts?.refresh ? 'hba-refresh' : 'hba-fence', () => {
      m.events.push(opts?.refresh ? 'hba-refresh' : 'hba-fence');
      const c = inst?.fleetDb?.containerName;
      if (c && m.sidecar[c] === 'restarting') return `the database's settings could not be read (${RESTARTING(c).error})`;
      return typeof m.fenceUp === 'function' ? m.fenceUp(!!opts?.refresh) : m.fenceUp;
    }),
    liftMigrateFence: () => effect('hba-lift', () => {
      m.events.push('hba-lift');
      return { result: m.fenceLift, detail: m.fenceLift === 'locked' ? 'Read-only file system' : undefined };
    }),
  };
}

export function fleetBackupMock(real: any): Record<string, unknown> {
  return {
    ...real,
    ...fenceMock(),
    shownRestoreNoticeFile: (id: string) => (id in m.notices ? m.notices[id] : m.notice),
    databaseSharers: (inst: any) => [inst, ...m.sharers.map(id => clone(m.bots[id]))],
    runningDatabaseSharers: async (inst: any) => [inst, ...m.sharers.map(id => clone(m.bots[id])), ...m.liveSharers.map(id => clone(m.bots[id]))],
  };
}

export function fleetReplicaMock(real: any): Record<string, unknown> {
  return { ...real, seedView: (inst: any) => (inst?.id in m.seeds ? m.seeds[inst.id] : m.seed) };
}

export function fleetSwitchMock(): Record<string, unknown> {
  return { switchTickOn: (id: string) => m.tickOn === id };
}

/** A sharer instance on the same database. */
export function seedSharer(id: string, over: Record<string, unknown> = {}, env: Record<string, string> = { DATA_BACKEND: 'postgres', DATA_BACKEND_URL: COMPANION_URL }): void {
  m.bots[id] = { id, displayName: id.toUpperCase(), sanitizedName: id, sourceUrl: SMDB, envVars: {}, status: 'running', createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z', ...over };
  m.env[id] = env;
  m.app[id] = true;
  m.sharers.push(id);
}

/** Fast timings for the lane; a row that needs a real wait sets its own. */
export function fastTiming(t: Record<string, unknown>): void {
  Object.assign(t, {
    getMs: 50, postMs: 50, hookMs: 50, saveTries: 6, savePauseMs: 0, readyMs: 30, readyPauseMs: 1, pollMs: 0, againMs: 0,
    unknownTries: 3, unknownPauseMs: 0, windowMs: 20, retryPauseMs: 1, sessionMs: 20, sessionPauseMs: 1,
    silentCheckMs: 5, silentParkMs: 30, keepDelaysMs: [0, 0, 0, 0, 0],
  });
}
