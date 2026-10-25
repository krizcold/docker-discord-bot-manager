import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Gate<T> = { promise: Promise<T>; resolve: (v: T) => void };
function gate<T>(): Gate<T> {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}

const st = vi.hoisted(() => ({
  bots: [] as any[],
  read: null as any,
  readGate: null as null | Promise<any>,
  posture: null as any,
  events: [] as string[],
  seeds: [] as string[],
  dataDir: '',
  dataDirGate: null as null | Promise<void>,
  liftGate: null as null | Promise<'lifted'>,
  fenceGate: null as null | Promise<{ ok: true }>,
  stopGate: null as null | Promise<{ success: boolean; error?: string }>,
  starts: 0,
  declines: 0,
}));

vi.mock('../../src/webui/server', () => ({ broadcastToClients: () => {} }));
vi.mock('../../src/docker/containerManager', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/docker/containerManager')>()),
  getAllBots: () => st.bots,
  getBot: (id: string) => st.bots.find(b => b.id === id) ?? null,
  updateInstanceFleetFailback: (id: string, run: any) => {
    const b = st.bots.find(x => x.id === id);
    if (b) b.fleetFailback = run;
  },
  updateInstanceFleetFailbackDeclined: (id: string, rec: any) => {
    const b = st.bots.find(x => x.id === id);
    if (b) b.fleetFailbackDeclined = rec;
    st.declines++;
  },
  updateInstanceFleetLastPosture: () => undefined,
  broadcastBotUpdated: () => undefined,
  stopBot: async () => (st.stopGate ? st.stopGate : { success: true }),
  startBot: async () => { st.starts++; return { success: true }; },
  startFleetDbSidecar: async () => ({ success: true }),
  applyFleetDbReplicaService: async () => ({ success: true }),
}));
vi.mock('../../src/instance/appHookClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/instance/appHookClient')>()),
  hasAppHooks: () => true,
}));
vi.mock('../../src/instance/appLifecycle', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/instance/appLifecycle')>()),
  getAppFacts: async () => (st.readGate ? st.readGate : st.read),
  postureFromRead: () => st.posture,
}));
vi.mock('../../src/instance/fleetBackup', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/instance/fleetBackup')>()),
  writeFenced: async () => false,
  fenceForConsent: async () => { const r = st.fenceGate ? await st.fenceGate : { ok: true as const }; st.events.push('fence'); return r; },
  liftConsentFence: async () => { const r = st.liftGate ? await st.liftGate : 'lifted'; st.events.push('lift'); return r; },
  failbackFenceLeft: () => false,
  runFleetDump: async () => ({ success: true, file: 'pre-failback-x.dump' }),
}));
vi.mock('../../src/instance/fleetReplica', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/instance/fleetReplica')>()),
  instanceDataDir: async () => { if (st.dataDirGate) await st.dataDirGate; return st.dataDir; },
  getFleetReplicaStatus: async () => ({ live: null }),
  reseedStalePrimary: () => { st.seeds.push('stale-primary'); return { success: true, started: true }; },
  provisionFleetReplica: () => { st.seeds.push('provision'); return { success: true, started: true }; },
  reseedStandby: async () => { st.seeds.push('standby'); return { success: true, started: true }; },
}));

import { cancelFailback, continueFailback, dismissFailback, parkInterruptedFailbacks } from '../../src/instance/fleetFailback';

const flush = async (n = 20): Promise<void> => { for (let i = 0; i < n; i++) await new Promise(r => setImmediate(r)); };

const run = (extra: Record<string, unknown> = {}): any => ({
  mode: 'failback', phase: 'wipe-consent', startedAt: 1, updatedAt: 1, standInNodeId: 'node-abcdef12',
  episode: 3, lineage: null, dump: null, consentAt: null, block: { host: 'standin.example', port: 5432 },
  serve: { publicHost: 'here.example', hostPort: 6543 }, stoppedByRun: false, parked: true,
  fence: { ok: true, error: null, at: 1, owned: true },
  ...extra,
});
const bot = (extra: Record<string, unknown> = {}): any => ({
  id: 'b1', displayName: 'Bot one', status: 'stopped',
  fleetDb: { containerName: 'db-b1', user: 'u', db: 'd', volume: 'vol-b1' },
  ...extra,
});
const live = (): any => st.bots[0];

beforeEach(() => {
  st.bots = [];
  st.read = { success: true, facts: { running: true, initialized: true } };
  st.readGate = null;
  st.posture = null;
  st.events = [];
  st.seeds = [];
  st.dataDirGate = null;
  st.liftGate = null;
  st.fenceGate = null;
  st.stopGate = null;
  st.starts = 0;
  st.declines = 0;
  st.dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'b23-1-'));
  fs.mkdirSync(path.join(st.dataDir, 'global', 'fleet'), { recursive: true });
  fs.writeFileSync(path.join(st.dataDir, 'global', 'fleet', 'copy-block.json'), JSON.stringify({ dsn: 'postgres://r:p@standin.example:5432/d', cert: 'CERT' }));
});

describe('R8-J19: Cancel and Continue exclude each other', () => {
  it('a Continue with consent inside Cancel\'s fence lift is refused and seeds nothing', async () => {
    st.bots = [bot({ fleetFailback: run() })];
    const lift = gate<'lifted'>();
    st.liftGate = lift.promise;
    const cancelling = cancelFailback(live());
    await flush();
    const cont = await continueFailback(live(), { consent: true });
    expect(cont.success).toBe(false);
    expect(cont.error).toMatch(/being cancelled or dismissed/);
    lift.resolve('lifted');
    const cancelled = await cancelling;
    await flush();
    expect(cancelled.success).toBe(true);
    expect(st.seeds).toEqual([]);
    expect(live().fleetFailback).toBeNull();
    expect(live().fleetFailbackDeclined?.mode).toBe('failback');
  });

  it('a Continue while Cancel reads the bot leaves Cancel refusing on the live run', async () => {
    st.bots = [bot({ fleetDb: undefined, fleetDbReplica: { containerName: 'copy-b1' }, fleetFailback: run({ phase: 'catching-up', fence: null }) })];
    const read = gate<any>();
    st.readGate = read.promise;
    const cancelling = cancelFailback(live());
    await flush();
    const cont = await continueFailback(live());
    expect(cont.success).toBe(true);
    read.resolve({ success: true, facts: { running: true, initialized: true } });
    const cancelled = await cancelling;
    expect(cancelled.success).toBe(false);
    expect(cancelled.error).toMatch(/The run is live/);
    expect(live().fleetFailback?.parked).toBe(false);
    expect(live().fleetFailbackDeclined).toBeFalsy();
    st.bots = [];
  });
});

describe('R9-J1: Dismiss claims the run before it awaits, and the runner re-checks ownership', () => {
  it('a Continue inside Dismiss\'s fence lift is refused and seeds nothing', async () => {
    st.bots = [bot({ fleetFailback: run({ phase: 'seeding', consentAt: 2 }) })];
    const lift = gate<'lifted'>();
    st.liftGate = lift.promise;
    const dismissing = dismissFailback(live());
    await flush();
    const cont = await continueFailback(live());
    expect(cont.success).toBe(false);
    expect(cont.error).toMatch(/being cancelled or dismissed/);
    lift.resolve('lifted');
    expect((await dismissing).success).toBe(true);
    await flush();
    expect(st.seeds).toEqual([]);
    expect(live().fleetFailback).toBeNull();
  });

  it('a second Cancel or a Dismiss while the first Cancel is in flight is refused', async () => {
    st.bots = [bot({ fleetFailback: run({ phase: 'seeding', consentAt: 2 }) })];
    const lift = gate<'lifted'>();
    st.liftGate = lift.promise;
    const first = cancelFailback(live());
    await flush();
    const second = cancelFailback(live());
    const dismissing = dismissFailback(live());
    await flush();
    lift.resolve('lifted');
    const [cancelled, again, dismissed] = await Promise.all([first, second, dismissing]);
    await flush();
    expect(again.success).toBe(false);
    expect(again.error).toMatch(/being cancelled or dismissed/);
    expect(dismissed.success).toBe(false);
    expect(dismissed.error).toMatch(/being cancelled or dismissed/);
    expect(cancelled.success).toBe(true);
    expect(cancelled.error).toBeUndefined();
    expect(st.events.filter(e => e === 'lift')).toEqual(['lift']);
    expect(st.declines).toBe(1);
    expect(live().fleetFailback).toBeNull();
    expect(live().fleetFailbackDeclined?.phase).toBe('seeding');
  });

  it('a run stopped while the block is read does not re-seed', async () => {
    st.bots = [bot({ fleetFailback: run({ phase: 'seeding', consentAt: 2 }) })];
    const dir = gate<void>();
    st.dataDirGate = dir.promise;
    expect((await continueFailback(live())).success).toBe(true);
    await flush();
    live().fleetFailback = { ...live().fleetFailback, parked: true, lastError: 'stopped elsewhere' };
    dir.resolve();
    await flush();
    expect(st.seeds).toEqual([]);
    expect(live().fleetFailback.lastError).toBe('stopped elsewhere');
  });
});

describe('R9-J1: the run hold re-reads the run record', () => {
  it('a seed asked with a stale snapshot of a run that was parked or closed is refused', async () => {
    const real = await vi.importActual<typeof import('../../src/instance/fleetReplica')>('../../src/instance/fleetReplica');
    const snapshot = bot({ fleetFailback: run({ phase: 'seeding', consentAt: 2, parked: false }) });
    st.bots = [bot({ fleetFailback: run({ phase: 'seeding', consentAt: 2, parked: true, lastError: 'cancelled by the operator' }) })];
    const parked = real.reseedStalePrimary(snapshot, 'postgres://r:p@standin.example:5432/d', 'CERT', 'here.example', 6543, false, { dumpDone: true, run: 1 });
    expect(parked.success).toBe(false);
    expect(parked.error).toMatch(/failback run that asked (was stopped|is no longer on record)/);
    st.bots = [bot({ fleetFailback: null })];
    const gone = real.provisionFleetReplica({ ...snapshot, fleetDb: undefined }, 'postgres://r:p@standin.example:5432/d', 'CERT', 'here.example', 6543, false, { run: 1 });
    expect(gone.success).toBe(false);
    expect(gone.error).toMatch(/failback run that asked is no longer on record/);
  });
});

describe('R22-J11: Cancel answers only after the runner has stopped, and lifts the fence it set', () => {
  it('a Cancel during the drop-back fence waits for it and then lifts it', async () => {
    st.posture = { read: 'ok', posture: { role: 'stand-in', live: false } };
    st.bots = [bot({
      fleetDb: undefined,
      fleetDbReplica: { containerName: 'copy-b1', user: 'u', db: 'd', volume: 'vol-copy', publicHost: 'here.example', hostPort: 6543 },
      fleetFailback: run({ mode: 'drop-back', phase: 'awaiting-block', fence: null }),
    })];
    const fence = gate<{ ok: true }>();
    st.fenceGate = fence.promise;
    expect((await continueFailback(live())).success).toBe(true);
    await flush();
    let answered = false;
    const cancelling = cancelFailback(live()).then(r => { answered = true; return r; });
    await flush();
    expect(answered).toBe(false);
    expect(st.events).toEqual([]);
    fence.resolve({ ok: true });
    const cancelled = await cancelling;
    expect(cancelled.success).toBe(true);
    expect(cancelled.error).toBeUndefined();
    expect(st.events).toEqual(['fence', 'lift']);
    expect(live().fleetFailback).toBeNull();
    expect(live().fleetFailbackDeclined?.mode).toBe('drop-back');
  });
});

describe('R15-J12: the dumping stop is recorded before it runs', () => {
  it('stoppedByRun is on record while the stop runs, survives a restart park, and Cancel starts the instance', async () => {
    st.bots = [bot({ status: 'running', fleetFailback: run({ phase: 'dumping', fence: null }) })];
    const stop = gate<{ success: boolean; error?: string }>();
    st.stopGate = stop.promise;
    expect((await continueFailback(live())).success).toBe(true);
    await flush();
    expect(live().fleetFailback.stoppedByRun).toBe(true);
    parkInterruptedFailbacks();
    expect(live().fleetFailback.parked).toBe(true);
    expect(live().fleetFailback.stoppedByRun).toBe(true);
    live().status = 'stopped';
    stop.resolve({ success: false, error: 'docker went away' });
    await flush();
    const cancelled = await cancelFailback(live());
    expect(cancelled.success).toBe(true);
    expect(st.starts).toBe(1);
  });

  it('a failed stop parks the run with stoppedByRun kept', async () => {
    st.bots = [bot({ status: 'running', fleetFailback: run({ phase: 'dumping', fence: null }) })];
    st.stopGate = Promise.resolve({ success: false, error: 'docker went away' });
    expect((await continueFailback(live())).success).toBe(true);
    await flush();
    expect(live().fleetFailback.parked).toBe(true);
    expect(live().fleetFailback.lastError).toMatch(/could not be stopped for the dump/);
    expect(live().fleetFailback.stoppedByRun).toBe(true);
  });
});
