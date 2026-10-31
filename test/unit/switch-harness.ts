// The collaborators of fleetSwitch and fleetMove, faked for the nm5 files: each mock factory below wraps the real
// module and answers from `h`, which a test sets per row. The registry is real (a temp DATA_DIR the file sets up);
// psql scripts go through switch-fake's spawn.
import * as fs from 'fs';
import * as path from 'path';
import { COPY_PEM, FIXTURE_PEM, fakeJoin, fakeJoinRecord } from './join-fake';
import { fake, freshDb, resetFake, switchSpawn } from './switch-fake';

type Login = { inRecovery: boolean; canLogin: boolean | null; sessions: number };
type Peer = import('../../src/instance/fleetJoin').PeerProbe;

export const h = ((globalThis as { __switchH?: Harness }).__switchH ??= freshHarness());

type CopyFacts = { ok: true; facts: { inRecovery: boolean; streaming: boolean; systemId: string; timeline: number; lsn: bigint } } | { ok: false; reason: string };

export interface Harness {
  events: string[];
  login: Login | { fail: string } | Login[];
  fence: { ok: true; on: false } | { ok: true; on: true; owner: string | null; persisted: boolean | null } | { ok: false; cls: 'other'; error: string };
  sidecar: Record<string, boolean | null>;
  proof: { ok: true; state: 'maintenance' | 'off'; enforcement: 'database'; botConfirmed: boolean; held?: { state: string; guilds?: number; files?: number } } | { ok: false; error: string };
  order: { settled: boolean; text: string };
  app: boolean | null;
  stop: { success: boolean; error?: string };
  dbStop: { success: boolean; error?: string };
  dbStart: { success: boolean; error?: string };
  start: { success: boolean; error?: string };
  memoryNotice: string | null;
  cert: { ok: true; pem: string } | { ok: false; kind: 'unreachable' | 'fingerprint'; reason: string; text: string };
  peer: (host: string, port: number) => Peer;
  copyFacts: CopyFacts | CopyFacts[];
  adopt: { success: boolean; error?: string; alone?: boolean; flipped?: boolean } | null;
  reseed: { success: boolean; error?: string; started?: boolean };
  hook: (action: string, body: unknown) => { ok: boolean; status?: number; unknown?: boolean; error?: string; body?: unknown };
  dump: { success: boolean; file?: string; error?: string };
  notified: Array<{ text: string; key?: string }>;
  hookCalls: Array<{ action: string; body: unknown }>;
  reseedCalls: Array<{ code: string; opts: unknown }>;
  adoptCalls: Array<{ opts: unknown }>;
  failSwitchWrite: string | null;
  failTakeoverWrite: string | null;
  endSessions: { ok: true } | { ok: false; cls: 'other'; error: string; left?: number };
  /** Lets a row apply what the mocked order would have written. */
  onOrder: ((to: string) => void) | null;
  notifyOutcome: Record<string, unknown> | 'real';
  block: { ok: true } | { ok: false; cls: 'other'; error: string };
  open: { ok: true } | { ok: false; cls: 'other'; error: string };
  /** fleetJoin.registerAddress: the calls, and the error it answers (null: registered). */
  registerCalls: Array<{ host: string; port: number; row: unknown }>;
  register: string | null;
  /** The app's companionDb mode (null: none, so postgresBackend is always true). */
  capsMode: { key: string; value: string } | null;
}

export function freshHarness(): Harness {
  return {
    events: [], login: { inRecovery: false, canLogin: false, sessions: 0 }, fence: { ok: true, on: false }, sidecar: {},
    proof: { ok: true, state: 'maintenance', enforcement: 'database', botConfirmed: true, held: { state: 'yes' } },
    order: { settled: true, text: 'The bot is running normally: its database login is restored, and it took the order to leave maintenance.' },
    app: true, stop: { success: true }, dbStop: { success: true }, dbStart: { success: true }, start: { success: true }, memoryNotice: null,
    cert: { ok: true, pem: FIXTURE_PEM },
    peer: () => ({ kind: 'unreachable', reason: 'connection refused' }),
    copyFacts: { ok: true, facts: { inRecovery: true, streaming: true, systemId: '7001', timeline: 1, lsn: 1n } },
    adopt: null, reseed: { success: true, started: true },
    hook: () => ({ ok: true, status: 200 }), dump: { success: true, file: 'pre-x-2026-10-28T12-00-00-000Z.dump' },
    notified: [], hookCalls: [], reseedCalls: [], adoptCalls: [], failSwitchWrite: null, failTakeoverWrite: null, endSessions: { ok: true }, onOrder: null,
    notifyOutcome: { dm: 'sent', posted: true, place: 'dm' },
    block: { ok: true }, open: { ok: true }, registerCalls: [], register: null, capsMode: null,
  };
}

export function resetHarness(over: Partial<Harness> = {}): void {
  Object.assign(h, freshHarness(), over);
  resetFake();
  fake.onEvent = e => h.events.push(e);
}

export const MAIN = { containerName: 'a-pg', user: 'app', db: 'app', volume: 'a-pgdata', replication: { role: 'replicator', password: 'replpass', hostPort: 5433, publicHost: 'main.example', certHost: 'main.example' } };
export const COPY = {
  containerName: 'c-pg', volume: 'c-replica', user: 'app', db: 'app', slot: 'slot_c', primaryHost: 'main.invalid', primaryPort: 15432,
  publicHost: 'copy.example', hostPort: 5434, certHost: 'copy.example', seededAt: 1,
};
export const SETTLED = { state: 'maintenance', message: 'Back soon', orderedAt: '2026-10-28T00:00:00.000Z', settled: true, hook: 'confirmed', login: 'blocked', savedByBot: 'maintenance', held: { state: 'yes' } };

export function registryFile(): string {
  return path.join(process.env.DATA_DIR!, 'instances.json');
}

/** Writes the registry: a main 'a' and a copy 'c' unless the row gives its own records. */
export function writeRegistry(instances: Record<string, Record<string, unknown>>): void {
  const all: Record<string, unknown> = {};
  for (const [id, over] of Object.entries(instances)) {
    all[id] = { id, sanitizedName: id, displayName: id.toUpperCase(), status: 'running', sourceUrl: 'https://example.invalid/fake/app', containerIds: [], createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z', ...over };
  }
  fs.mkdirSync(process.env.DATA_DIR!, { recursive: true });
  fs.writeFileSync(registryFile(), JSON.stringify({ instances: all }, null, 2));
}

export function stored(id: string): any {
  return JSON.parse(fs.readFileSync(registryFile(), 'utf-8')).instances[id];
}

export function mainFixture(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { fleetDb: { ...MAIN }, maintenance: { ...SETTLED }, ...over };
}

export function copyFixture(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { fleetDbReplica: { ...COPY }, fleetJoin: fakeJoinRecord(), maintenance: { ...SETTLED }, ...over };
}

export { fake, freshDb, COPY_PEM, FIXTURE_PEM, fakeJoin };

// ─── Mock factories ───

export function childProcessMock(real: typeof import('child_process')): Record<string, unknown> {
  const spawn = (cmd: string, args: string[], opts?: any) => switchSpawn(cmd, args, opts);
  const execFile = (_cmd: string, _args: string[], optsOrCb: unknown, maybeCb?: unknown) => {
    const cb = (typeof optsOrCb === 'function' ? optsOrCb : maybeCb) as (e: Error | null, o: string, s: string) => void;
    setTimeout(() => cb?.(null, '', ''), 0);
    return { on: () => undefined } as any;
  };
  const exec = (_cmd: string, opts: any, cb?: any) => {
    const done = typeof opts === 'function' ? opts : cb;
    done?.(null, { stdout: '', stderr: '' });
  };
  return { ...real, spawn, execFile, exec, default: { ...real, spawn, execFile, exec } };
}

export function dbLoginMock(real: typeof import('../../src/instance/dbLogin')): Record<string, unknown> {
  let reads = 0;
  return {
    ...real,
    readBotLogin: async () => {
      const l = h.login;
      if ('fail' in l) return { ok: false, cls: 'other', error: l.fail };
      if (Array.isArray(l)) return { ok: true, login: l[Math.min(reads++, l.length - 1)] };
      return { ok: true, login: l };
    },
    readWriteFence: async () => { h.events.push('fence-read'); return h.fence; },
    sidecarRunning: async (c: string) => (c in h.sidecar ? h.sidecar[c] : true),
    blockBotLogin: async () => { h.events.push('block'); return h.block; },
    openBotLogin: async () => { h.events.push('open'); return h.open; },
    endBotSessions: async () => { h.events.push('end-sessions'); return h.endSessions; },
    ensureManagerDbRole: async () => ({ ok: true }),
  };
}

export function maintenanceMock(real: typeof import('../../src/instance/maintenance')): Record<string, unknown> {
  return {
    ...real,
    requireMaintenance: async () => { h.events.push('require-maintenance'); return h.proof; },
    runMaintenanceOrder: async (_id: string, to: string) => { h.events.push(`order:${to}`); h.onOrder?.(to); return h.order; },
  };
}

export function containerManagerMock(real: typeof import('../../src/docker/containerManager')): Record<string, unknown> {
  return {
    ...real,
    stopBotInOp: async (_id: string, op: string) => { h.events.push(`stop-bot:${op}`); return h.stop; },
    startFleetDbSidecar: async (_id: string, opts: any = {}) => { h.events.push(`db-start${opts.handedOver ? ':override' : ''}`); return h.dbStart; },
    stopFleetDbSidecar: async () => { h.events.push('db-stop'); if (h.dbStop.success) h.sidecar['a-pg'] = false; return h.dbStop; },
    appContainerRunning: async () => h.app,
    startBot: async () => { h.events.push('start-bot'); return h.start; },
    updateInstanceFleetDbSwitch: (id: string, patch: any) => {
      if (h.failSwitchWrite) throw new Error(h.failSwitchWrite);
      return real.updateInstanceFleetDbSwitch(id, patch);
    },
    updateInstanceFleetDbReplicaTakeover: (id: string, t: any) => {
      if (h.failTakeoverWrite) throw new Error(h.failTakeoverWrite);
      return real.updateInstanceFleetDbReplicaTakeover(id, t);
    },
    broadcastBotUpdated: () => undefined,
  };
}

export function fleetBackupMock(real: typeof import('../../src/instance/fleetBackup')): Record<string, unknown> {
  return {
    ...real,
    shownRestoreNoticeFile: (id: string) => h.memoryNotice ?? real.shownRestoreNoticeFile(id),
    runFleetDump: async (_inst: unknown, prefix: string) => {
      h.events.push(`dump:${prefix}`);
      if (!h.dump.success) return h.dump;
      return { success: true, file: `${prefix}2026-10-28T12-00-00-000Z.dump` };
    },
  };
}

export function fleetJoinMock(real: typeof import('../../src/instance/fleetJoin')): Record<string, unknown> {
  return {
    ...real,
    mainCertificate: async () => h.cert,
    ensureClientImage: async () => null,
    peerProbe: async (_inst: unknown, code: { host: string; port: number }) => { h.events.push(`probe:${code.host}`); return h.peer(code.host, code.port); },
    readCopyFacts: async () => (Array.isArray(h.copyFacts) ? (h.copyFacts.length > 1 ? h.copyFacts.shift() : h.copyFacts[0]) : h.copyFacts),
    ensureProbeCert: () => '/host/probe.crt',
    readCopyCert: async () => COPY_PEM,
    registerAddress: async (_inst: unknown, code: { host: string; port: number }, _pem: string, row: unknown) => {
      h.registerCalls.push({ host: code.host, port: code.port, row });
      h.events.push(`register:${code.host}`);
      return h.register;
    },
  };
}

export function fleetReplicaMock(real: typeof import('../../src/instance/fleetReplica')): Record<string, unknown> {
  return {
    ...real,
    adoptPromotedReplica: async (inst: { id: string }, opts: any = {}) => {
      h.adoptCalls.push({ opts });
      h.events.push('adopt');
      if (h.adopt) return h.adopt;
      const cm = await import('../../src/docker/containerManager');
      // A copy with an address runs Enable after the flip, which records replication (D58 reads it).
      const repl = opts.alone ? undefined : { role: 'replicator', password: 'replpass', hostPort: 5434, publicHost: 'copy.example', certHost: 'copy.example' };
      const r = cm.adoptFleetDbReplicaAsPrimary(inst.id, repl as any, opts.restoreNotice, opts.formerMain);
      return r.success ? { success: true, restartRequired: true, flipped: true, ...(opts.alone ? { alone: true } : {}) } : r;
    },
    reseedStalePrimary: (_inst: unknown, code: string, _h?: string, _p?: number, _c?: boolean, opts: unknown = {}) => {
      h.reseedCalls.push({ code, opts });
      h.events.push('reseed');
      return h.reseed;
    },
  };
}

export function appHookMock(real: typeof import('../../src/instance/appHookClient')): Record<string, unknown> {
  return {
    ...real,
    capabilityRefusal: () => null,
    callAppHook: async (_inst: unknown, action: string, _m: string, body: unknown) => {
      h.hookCalls.push({ action, body });
      h.events.push(`hook:${action}`);
      return h.hook(action, body);
    },
  };
}

export function backupCheckMock(real: typeof import('../../src/instance/backupCheck')): Record<string, unknown> {
  return {
    ...real,
    notifyOwner: async (_inst: unknown, text: string, key?: string) => { h.notified.push({ text, ...(key ? { key } : {}) }); return h.notifyOutcome === 'real' ? real.notifyOwner(_inst as any, text, key as string) : h.notifyOutcome; },
  };
}

export const ENV = { DATABASE_URL: 'postgresql://app:apppass@a-pg:5432/app?sslmode=no-verify', DATA_BACKEND: 'postgres' };

export function envMock(real: typeof import('../../src/env/manager')): Record<string, unknown> {
  return {
    ...real,
    getEnvVarsWithStatus: () => ({ vars: { ...ENV }, corrupt: false, undecryptable: [] }),
    getEnvVars: () => ({ ...ENV }),
  };
}

export function capsMock(real: typeof import('../../src/config/appCapabilities')): Record<string, unknown> {
  return {
    ...real,
    findAppCapabilities: () => ({ companionDb: { env: { url: 'DATABASE_URL', ...(h.capsMode ? { mode: h.capsMode } : {}) }, user: 'app', database: 'app' }, hooks: { port: 3000, basePath: '/hooks' } }),
  };
}

/** The psql scripts sent to one container, in order. */
export function scripts(container: string): string[] {
  return fake.calls.filter(c => c.args[0] === 'exec' && c.args.includes(container)).map(c => c.input);
}

export function seedDbs(): void {
  fake.dbs['a-pg'] = freshDb({ slots: { slot_c: { active: true, state: 'streaming', replay: '0/5000000' } }, addresses: [{ host: 'copy.example', port: 5434, slot: 'slot_c', machine: 'copy.example', cert: COPY_PEM }] });
  fake.dbs['c-pg'] = freshDb({ recovery: true });
}

export { fakeJoinRecord };
