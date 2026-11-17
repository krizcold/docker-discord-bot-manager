// NX5's manager rig: a fake save-order database answering the scripts the order, the final read, the lanes and
// Running send through docker exec psql (processStart is faked, so the route the build takes to psql does not
// matter), and the maintenance mocks of nm1-order with the app's save order switchable.
// The order write and the read are recognised by tags: switchSql's saveOrderSql and SAVE_READ_SQL are mocked to
// emit them (the real SQL is nx5-pg's). Running is recognised by its real text (ALTER ROLE and save_acks) or a tag.
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';

export interface Claim { holder: string; name: string; node?: string; expires: number; released?: boolean; count?: number; agoMs?: number }
export interface Ack { process: string; order: string; saved: boolean | null; unsavedGuilds?: number | null; unsavedFiles?: number | null; unansweredGuilds?: number | null; unconfirmedFiles?: number | null; unansweredFiles?: number | null }
export interface OrderRow { id: string; state: 'maintenance' | 'running'; message: string; generation: number; reason: 'order' | 'restore'; upMs: number | null }

export interface SoDb {
  tables: boolean;
  genTable: boolean;
  generation: number | null;
  order: OrderRow | null;
  acks: Ack[];
  claimTables: boolean;
  clock: number | null;
  claims: Claim[];
  reshard: { state: 'standby' | 'flipped' | 'done'; toCount: number } | null;
  readOnly: boolean;
  /** Errors each step answers, one per call, consumed in order. */
  failNext: Partial<Record<'order' | 'read' | 'running', string[]>>;
  /** An error a step answers on every call. */
  failAlways: Partial<Record<'order' | 'read' | 'running', string>>;
  /** Processes that answer the current maintenance order at each read (a bot's renewal). */
  autoAck: Record<string, Omit<Ack, 'process' | 'order'>>;
  reads: number;
  orderWrites: number;
  runningWrites: number;
}

export function freshSoDb(over: Partial<SoDb> = {}): SoDb {
  return {
    tables: true, genTable: true, generation: 3, order: null, acks: [], claimTables: true, clock: 100_000,
    claims: [], reshard: null, readOnly: false, failNext: {}, failAlways: {}, autoAck: {}, reads: 0, orderWrites: 0, runningWrites: 0, ...over,
  };
}

type Script = { args: string[]; sql: string; db: string; container: string };
type Answer = { code: number; stdout: string; stderr: string };

export interface Kit {
  dbs: Record<string, SoDb>;
  scripts: Script[];
  /** Called before each read is answered (after autoAck): the n-th read of the container. */
  onRead: ((d: SoDb, n: number) => void | Promise<void>) | null;
  /** Any script the save-order fake does not recognise. */
  other: ((args: string[], sql: string) => Answer) | null;
  newIds: number;
}

export const k: Kit = ((globalThis as { __nx5Kit?: Kit }).__nx5Kit ??= { dbs: {}, scripts: [], onRead: null, other: null, newIds: 0 });

export function resetKit(): void {
  k.dbs = {}; k.scripts = []; k.onRead = null; k.other = null; k.newIds = 0;
}

const ok = (stdout = ''): Answer => ({ code: 0, stdout, stderr: '' });
const err = (stderr: string): Answer => ({ code: 1, stdout: '', stderr });
const NO_TABLE = (t: string) => `ERROR:  relation "smdb_manager.${t}" does not exist`;

function failing(d: SoDb, step: 'order' | 'read' | 'running'): Answer | null {
  const q = d.failNext[step];
  if (q && q.length) { const e = q.shift()!; if (e) return err(e); }
  const a = d.failAlways[step];
  return a ? err(a) : null;
}

const current = (d: SoDb) => d.generation ?? 0;

export function expectedOf(d: SoDb): { expected: Array<{ process: string; name: string; agoMs: number }>; notSeen: Array<{ process: string; name: string; agoMs: number }> } {
  const up = d.order?.upMs;
  if (!d.claimTables || up === null || up === undefined) return { expected: [], notSeen: [] };
  const standby = d.reshard && (d.reshard.state === 'standby' || d.reshard.state === 'flipped') ? d.reshard.toCount : null;
  const rows = d.claims.filter(c => !c.released && (standby === null || c.count !== standby));
  const agoOf = (p: string) => Math.min(...rows.filter(c => c.holder === p).map(c => c.agoMs ?? 4000));
  const live = [...new Set(rows.filter(c => c.expires > up).map(c => c.holder))];
  const lapsed = [...new Set(rows.filter(c => c.expires <= up && !live.includes(c.holder)).map(c => c.holder))];
  const nameOf = (p: string) => rows.find(c => c.holder === p)!.name;
  return {
    expected: live.map(p => ({ process: p, name: nameOf(p), agoMs: agoOf(p) })),
    notSeen: lapsed.map(p => ({ process: p, name: nameOf(p), agoMs: agoOf(p) })),
  };
}

/** The JSON line SAVE_READ_SQL answers (tests-notes.md names its shape). */
export function rowsOf(d: SoDb): Record<string, unknown> {
  const o = d.order;
  return {
    order: o ? { id: o.id, state: o.state, message: o.message, current: o.generation === current(d), reason: o.reason, upMs: o.upMs } : null,
    claims: d.claimTables,
    ...expectedOf(d),
    acks: d.acks.map(a => ({ unsavedGuilds: 0, unsavedFiles: 0, unansweredGuilds: 0, unconfirmedFiles: 0, unansweredFiles: 0, ...a })),
  };
}

function tag(sql: string, name: string): any | null {
  const at = sql.indexOf(`-- nx5:${name}`);
  if (at < 0) return null;
  const rest = sql.slice(at + `-- nx5:${name}`.length).trim().split('\n')[0];
  return rest ? JSON.parse(rest) : {};
}

async function answerOf(args: string[], sql: string): Promise<Answer> {
  const psql = args.indexOf('psql');
  const container = psql > 0 ? args[psql - 1] : '';
  const db = args.includes('-d') ? args[args.indexOf('-d') + 1] : '';
  k.scripts.push({ args, sql, db, container });
  const d = k.dbs[container];
  const exempt = args.some(a => a.includes('default_transaction_read_only=off'));
  const other = () => (k.other ? k.other(args, sql) : ok(''));
  if (!d) return other();
  if (sql.includes('-- nx5:clock')) return ok(`clock|${d.claimTables && d.clock !== null ? d.clock : ''}\n`);
  const order = tag(sql, 'order');
  if (order) {
    d.orderWrites++;
    h.events?.push('order-write');
    const f = failing(d, 'order');
    if (f) return f;
    if (d.readOnly && !exempt) return err('ERROR:  cannot execute CREATE SCHEMA in a read-only transaction');
    d.tables = true; d.genTable = true;
    const o = d.order;
    const keep = !!o && order.keepId !== null && o.id === order.keepId && o.state === 'maintenance' && o.generation === current(d) && (o.reason === 'order' || order.keepRestore === true);
    if (keep) o!.message = order.message;
    else {
      d.order = { id: order.newId, state: 'maintenance', message: order.message, generation: current(d), reason: 'order', upMs: d.claimTables ? d.clock : null };
      d.acks = [];
    }
    const r = d.order!;
    return ok(`${r.id}|${keep ? 't' : 'f'}|${r.generation}|${r.upMs ?? ''}\n`);
  }
  if (sql.includes('-- nx5:read')) {
    d.reads++;
    h.events?.push('read');
    const f = failing(d, 'read');
    if (f) return f;
    if (!d.tables) return err(NO_TABLE('save_order'));
    const o = d.order;
    if (o && o.state === 'maintenance' && o.generation === current(d) && h.db?.canLogin !== false) {
      for (const [p, a] of Object.entries(d.autoAck)) {
        if (!d.claims.some(c => c.holder === p && !c.released)) continue;
        d.acks = d.acks.filter(x => x.process !== p);
        d.acks.push({ process: p, order: o.id, ...a });
      }
    }
    await k.onRead?.(d, d.reads);
    return ok(`${JSON.stringify(rowsOf(d))}\n`);
  }
  const running = tag(sql, 'running');
  if (running || (/INSERT INTO smdb_manager\.save_order[\s\S]*'running'/.test(sql) && sql.includes('DELETE FROM smdb_manager.save_acks'))) {
    d.runningWrites++;
    h.events?.push('running');
    const f = failing(d, 'running');
    if (f) return f;
    if (d.readOnly && !exempt) return err('ERROR:  cannot execute CREATE SCHEMA in a read-only transaction');
    d.tables = true; d.genTable = true;
    const id = d.order?.id ?? running?.newId ?? `run-${++k.newIds}`;
    d.order = { id, state: 'running', message: d.order?.message ?? '', generation: current(d), reason: 'order', upMs: d.order?.upMs ?? null };
    d.acks = [];
    return ok('');
  }
  return other();
}

function fakeChild(args: string[]): any {
  const c: any = new EventEmitter();
  c.stdout = new PassThrough();
  c.stderr = new PassThrough();
  c.stdin = new PassThrough();
  let input = '';
  c.stdin.on('data', (b: Buffer) => { input += b.toString(); });
  c.kill = () => true;
  c.stdin.on('finish', async () => {
    const at = args.indexOf('-c');
    const a = await answerOf(args, input || (at >= 0 ? args[at + 1] : ''));
    setTimeout(() => {
      c.stdout.end(a.stdout);
      c.stderr.end(a.stderr);
      setTimeout(() => c.emit('close', a.code), 1);
    }, 1);
  });
  return c;
}

export function processStartMock(real: typeof import('../../src/docker/processStart')): Record<string, unknown> {
  return {
    ...real,
    startProcess: (_cmd: string, args: readonly string[]) => ({ child: fakeChild([...args]) }),
    execFileGuarded: (_cmd: string, args: readonly string[], _opts: unknown, cb: (e: any, o: string, s: string) => void) => {
      const at = args.indexOf('-c');
      void answerOf([...args], at >= 0 ? args[at + 1] : '').then(a => setTimeout(() => cb(a.code ? Object.assign(new Error(a.stderr), { code: a.code }) : null, a.stdout, a.stderr), 1));
    },
  };
}

export function switchSqlMock(real: any): Record<string, unknown> {
  return {
    ...real,
    saveOrderSql: (p: unknown) => `-- nx5:order ${JSON.stringify(p)}\n`,
    SAVE_READ_SQL: '-- nx5:read\n',
    CLAIM_CLOCK_READ_SQL: '-- nx5:clock\n',
    runningOpenSql: (p: unknown) => (h.realRunning ? real.runningOpenSql(p) : `-- nx5:running ${JSON.stringify(p)}\n`),
  };
}

/** The scripts that wrote save_order (an order write or Running) to a container. */
export function saveOrderWrites(container = 'b1-fleet-postgres'): Script[] {
  return k.scripts.filter(s => s.container === container && (s.sql.includes('-- nx5:order') || s.sql.includes('-- nx5:running') || /(INSERT INTO|UPDATE) smdb_manager\.save_order/.test(s.sql)));
}

// ─── The maintenance harness (nm1-order's mocks) ───

export interface H {
  inst: any;
  env: { vars: Record<string, string>; undecryptable: string[]; encrypted: string[]; corrupt: boolean };
  lock: string | null;
  app: boolean | null;
  appAfterStart: boolean;
  /** The app container still runs after a stop that answered success. */
  appAfterStop: boolean;
  sidecar: boolean | null;
  db: { inRecovery: boolean; canLogin: boolean | null; sessions: number };
  /** Login reads answered in turn before h.db: an error text fails that read, null reads h.db. */
  readQueue: Array<string | null>;
  readFail: string | null;
  /** Fails every login read made before a block in this pass's events. */
  failPreBlock: string | null;
  reads: number;
  dbUp: { success: boolean; error?: string };
  ensure: any;
  block: any;
  end: any;
  open: any;
  fence: any;
  hook: (body: any) => any;
  hookBodies: any[];
  start: { success: boolean; error?: string };
  stop: { success: boolean; error?: string };
  events: string[];
  writes: any[];
  /** An error text fails that record write (it throws, nothing is kept); null lets it land. */
  writeFail: ((rec: any) => string | null) | null;
  saveOrder: boolean;
  realRunning: boolean;
}

export const h: H = ((globalThis as { __nx5H?: H }).__nx5H ??= {} as H);

export function resetH(): void {
  Object.assign(h, {
    inst: null, env: { vars: {}, undecryptable: [], encrypted: [], corrupt: false }, lock: null, app: true, appAfterStart: true, appAfterStop: false, sidecar: true,
    db: { inRecovery: false, canLogin: true, sessions: 1 }, readQueue: [], readFail: null, failPreBlock: null, reads: 0, dbUp: { success: true }, ensure: { ok: true },
    block: { ok: true }, end: { ok: true }, open: { ok: true }, fence: { ok: true, on: false },
    hook: () => ({ ok: true, status: 200, body: { success: true, saved: true } }), hookBodies: [], start: { success: true }, stop: { success: true },
    events: [], writes: [], writeFail: null, saveOrder: true, realRunning: false,
  });
}

export const SMDB = 'https://github.com/x/fully-modular-discord-bot';
export const CONTAINER = 'b1-fleet-postgres';
export const FLEETDB = { containerName: CONTAINER, user: 'smdb', db: 'smdb', volume: 'v' };

export function setupBot(maintenance?: any, over: Record<string, unknown> = {}): void {
  h.inst = { id: 'b1', displayName: 'B1', sourceUrl: SMDB, envVars: {}, createdAt: '2026-10-01T00:00:00.000Z', status: 'running', fleetDb: { ...FLEETDB }, ...over };
  if (maintenance) h.inst.maintenance = maintenance;
  h.env = { vars: { DATA_BACKEND: 'postgres' }, undecryptable: [], encrypted: [], corrupt: false };
}

export const settledRec = (state: string, over: Record<string, unknown> = {}) => ({ state, message: 'old', orderedAt: '2026-10-01T00:00:00.000Z', settled: true, hook: 'confirmed', login: state === 'running' ? 'open' : 'blocked', savedByBot: state === 'running' ? 'running' : 'maintenance', ...over });

export function envMock(real: any): Record<string, unknown> {
  return { ...real, getEnvVarsWithStatus: () => h.env };
}

export function capsMock(real: any): Record<string, unknown> {
  return {
    ...real,
    findAppCapabilities: (url: string) => {
      const caps = real.findAppCapabilities(url);
      if (!caps?.companionDb) return caps;
      const companionDb = { ...caps.companionDb };
      if (h.saveOrder) companionDb.saveOrder = true;
      else delete companionDb.saveOrder;
      return { ...caps, companionDb };
    },
  };
}

export function containerManagerMock(): Record<string, unknown> {
  return {
    SHUTDOWN_REFUSAL: 'shutting down',
    isShuttingDown: () => false,
    registryFault: () => null,
    getBot: (id: string) => (h.inst && h.inst.id === id ? JSON.parse(JSON.stringify(h.inst)) : null),
    getAllBots: () => (h.inst ? [JSON.parse(JSON.stringify(h.inst))] : []),
    isBotBusy: () => h.lock,
    migrateRefusal: () => null,
    heldOrderRefusal: () => null,
    databaseHoldRefusal: () => null,
    deleteLaneRefusal: () => null,
    updateInstanceMaintenance: (_id: string, rec: any) => {
      const fail = h.writeFail?.(rec) ?? null;
      if (fail) throw new Error(fail);
      h.writes.push(rec ? JSON.parse(JSON.stringify(rec)) : null);
      if (rec) h.inst.maintenance = JSON.parse(JSON.stringify(rec));
      else delete h.inst.maintenance;
    },
    withExternalBotOp: async (_id: string, op: string, fn: () => Promise<unknown>) => {
      if (h.lock) throw new Error(`Operation '${h.lock}' is already in progress for this bot`);
      h.lock = op;
      try { return await fn(); } finally { h.lock = null; }
    },
    appContainerRunning: async () => h.app,
    startBotInOp: async (_id: string, op: string) => { h.events.push(`start:${op}`); if (h.start.success) h.app = h.appAfterStart; return h.start; },
    stopBotInOp: async (_id: string, op: string) => { h.events.push(`stop:${op}`); if (h.stop.success) { h.app = h.appAfterStop; } return h.stop; },
    startFleetDbSidecar: async () => { h.events.push('db-up'); if (h.dbUp.success) h.sidecar = true; return h.dbUp; },
  };
}

export function dbLoginMock(real: any): Record<string, unknown> {
  return {
    ...real,
    readWriteFence: async () => { h.events.push('fence-read'); return h.fence; },
    sidecarRunning: async () => h.sidecar,
    ensureManagerDbRole: async () => h.ensure,
    readBotLogin: async () => {
      h.reads++;
      h.events.push('login-read');
      if (h.readQueue.length) {
        const q = h.readQueue.shift();
        if (q) return { ok: false, cls: 'other', error: q };
      }
      if (h.failPreBlock && !h.events.includes('block')) return { ok: false, cls: 'other', error: h.failPreBlock };
      return h.readFail ? { ok: false, cls: 'other', error: h.readFail } : { ok: true, login: { ...h.db } };
    },
    blockBotLogin: async () => { h.events.push('block'); if (h.block.ok) h.db.canLogin = false; return h.block; },
    endBotSessions: async () => { h.events.push('end-sessions'); if (h.end.ok) h.db.sessions = 0; return h.end; },
    openBotLogin: async () => {
      h.events.push('open');
      const r = typeof h.open === 'function' ? await h.open() : h.open;
      if (r.ok) h.db.canLogin = true;
      return r;
    },
  };
}

export function appHookMock(real: any): Record<string, unknown> {
  return {
    ...real,
    callAppHook: async (_inst: unknown, action: string, method: string, body: any, timeout: number) => {
      h.events.push(`hook:${body.state}`);
      h.hookBodies.push({ action, method, body, timeout });
      return h.hook(body);
    },
  };
}

export function fleetReplicationMock(real: any): Record<string, unknown> {
  return { ...real, provisionManagedRoles: async () => ({ ok: true, wrote: [] }) };
}

/** Every script the fake answered for the order transaction or the read, by kind, in order. */
export function kinds(container = CONTAINER): string[] {
  return k.scripts.filter(s => s.container === container).map(s => (s.sql.includes('-- nx5:order') ? 'order' : s.sql.includes('-- nx5:read') ? 'read' : s.sql.includes('-- nx5:running') || /INSERT INTO smdb_manager\.save_order[\s\S]*'running'/.test(s.sql) ? 'running' : 'other'));
}

/** A fresh save-order database for the bot's container; Running's row leaves the login to openBotLogin's mock (G8-1). */
export function wire(): void {
  k.dbs[CONTAINER] = freshSoDb();
}

export const claim = (holder: string, name: string, expires = 200_000, over: Partial<Claim> = {}): Claim => ({ holder, name, expires, ...over });
