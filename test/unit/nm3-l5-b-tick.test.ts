import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm3-l5-b-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return {
    dir,
    sent: [] as string[],
    notify: { dm: 'sent' } as { dm: string; dmError?: string },
    gate: null as Promise<void> | null,
    onSend: null as (() => void) | null,
    busyOp: null as string | null,
    backupBusy: false,
    shutting: false,
    noJoin: false,
    envFail: '',
    refreshFail: '',
    afterRefresh: null as (() => void) | null,
    copyThrow: '',
    saveFail: '',
    saves: 0,
    envWrites: 0,
    allCalls: 0,
    lockCheck: null as null | (() => Promise<boolean>),
    startReason: '',
  };
});

vi.mock('child_process', async (importOriginal) => (await import('./join-fake')).childProcessMock(await importOriginal<typeof import('child_process')>()));
vi.mock('../../src/casaos/detector', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/casaos/detector')>()),
  getDeploymentMode: async () => 'docker',
}));
vi.mock('../../src/instance/backupCheck', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/instance/backupCheck')>()),
  notifyOwner: async (_i: unknown, text: string) => { h.sent.push(text); h.onSend?.(); if (h.gate) await h.gate; return h.notify; },
}));
vi.mock('../../src/instance/fleetBackupGuards', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/instance/fleetBackupGuards')>();
  return { ...real, isFleetBackupBusy: (id: string) => h.backupBusy || real.isFleetBackupBusy(id) };
});
vi.mock('../../src/instance/fleetJoin', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/instance/fleetJoin')>();
  return {
    ...real,
    storedJoin: (i: any) => h.noJoin ? null : real.storedJoin(i),
    writeEnvList: async (id: string, opts?: any) => { h.envWrites++; if (h.envFail) throw new Error(h.envFail); return real.writeEnvList(id, opts); },
    refreshJoin: async (i: any) => { if (h.refreshFail) throw new Error(h.refreshFail); const r = await real.refreshJoin(i); h.afterRefresh?.(); return r; },
    readCopyFacts: async (rec: any) => { if (h.copyThrow) throw new Error(h.copyThrow); return real.readCopyFacts(rec); },
  };
});
vi.mock('../../src/instance/fleetReplica', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/instance/fleetReplica')>();
  return {
    ...real,
    startAutoRebuild: (i: any, slot: any, check: () => Promise<boolean>) => {
      h.lockCheck = check;
      return h.startReason ? { started: false, reason: h.startReason } : { started: true };
    },
  };
});
vi.mock('../../src/docker/containerManager', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/docker/containerManager')>();
  return {
    ...real,
    deployedComposeExists: () => true,
    markPendingApplyIfRunning: async () => undefined,
    isBotBusy: (id: string) => h.busyOp ?? real.isBotBusy(id),
    isShuttingDown: () => h.shutting || real.isShuttingDown(),
    getAllBots: () => { h.allCalls++; return real.getAllBots(); },
    updateInstanceFleetCopyAlert: (id: string, key: string, alert: any) => {
      h.saves++;
      if (h.saveFail) throw new Error(h.saveFail);
      return real.updateInstanceFleetCopyAlert(id, key, alert);
    },
  };
});

import * as fs from 'fs';
import * as path from 'path';
import * as containerManager from '../../src/docker/containerManager';
import * as envManager from '../../src/env/manager';
import { certSource } from '../../src/instance/fleetJoin';
import {
  computeVerdict, joinView, lastVerdict, rebuildView, runFleetCopyTick, startFleetCopyWatch, stepCopyAlerts, stopFleetCopyWatch,
} from '../../src/instance/fleetCopyWatch';
import { docker, fakeJoinRecord, FIXTURE_FP, FIXTURE_PEM, resetDocker } from './join-fake';

const SMDB = 'https://example.invalid/fake/super-modular-discord-bot';
const REGISTRY = path.join(h.dir, 'instances.json');
const REPLICA = {
  containerName: 'b-fleet-postgres-replica', volume: 'b-fleet-postgres-replica-data', slot: 'fleet_standby_b',
  primaryHost: 'main.invalid', primaryPort: 15432, publicHost: 'copy.invalid', hostPort: 15433, certHost: 'copy.invalid',
  user: 'smdb', db: 'smdb', seededAt: 1,
};
const FLEETDB = { containerName: 'b-fleet-postgres', user: 'smdb', db: 'smdb', volume: 'b-fleet-postgres-data' };
const writeRegistry = (over: Record<string, unknown> = {}) => fs.writeFileSync(REGISTRY, JSON.stringify({ instances: { b: {
  id: 'b', sanitizedName: 'b', displayName: 'B', titleName: 'B', status: 'running', sourceType: 'git', sourceUrl: SMDB,
  envVars: { DATA_BACKEND: 'postgres' }, createdAt: '2026-10-24T00:00:00.000Z', updatedAt: '2026-10-24T00:00:00.000Z',
  fleetJoin: fakeJoinRecord(), fleetDbReplica: REPLICA, ...over,
} } }, null, 2));
const bot = () => containerManager.getBot('b')!;
const seed = (at: number, over: Record<string, unknown> = {}) => ({
  purpose: 'reseed-standby', phase: 'seeding', startedAt: at, updatedAt: at, primaryHost: 'main.invalid', primaryPort: 15432,
  slot: 'fleet_standby_b', ...over,
});
const realFetch = certSource.fetch;
let fetches = 0;
let clock = Date.now();
let warn: ReturnType<typeof vi.spyOn>;
let log: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;
const lines = (spy: ReturnType<typeof vi.spyOn>) => spy.mock.calls.map((c: unknown[]) => String(c[0])).filter((l: string) => l.startsWith('[FleetCopy]'));
const TIMELINE2 = 'the main is on timeline 2 and this copy on timeline 1, so the main changed since this copy was made';

beforeEach(() => {
  resetDocker();
  docker.copy = 'true||7001|1|0/4000000';
  Object.assign(h, {
    sent: [], notify: { dm: 'sent' }, gate: null, onSend: null, busyOp: null, backupBusy: false, shutting: false, noJoin: false,
    envFail: '', refreshFail: '', afterRefresh: null, copyThrow: '', saveFail: '', saves: 0, envWrites: 0, allCalls: 0,
    lockCheck: null, startReason: '',
  });
  fetches = 0;
  certSource.fetch = async () => { fetches++; return { ok: true, pem: FIXTURE_PEM, fp: FIXTURE_FP }; };
  fs.rmSync(path.join(h.dir, 'bots'), { recursive: true, force: true });
  fs.mkdirSync(path.join(h.dir, 'bots', 'b', 'env'), { recursive: true });
  writeRegistry();
  clock = Date.now();
  warn = vi.spyOn(console, 'warn');
  log = vi.spyOn(console, 'log');
  error = vi.spyOn(console, 'error');
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  stopFleetCopyWatch();
});
afterAll(() => {
  certSource.fetch = realFetch;
  fs.rmSync(h.dir, { recursive: true, force: true });
});

describe('what keeps a rebuild waiting', () => {
  it.each([
    ['a running seed', () => writeRegistry({ fleetDbReplicaSeed: seed(clock) }), 'a seed is running'],
    ['an operation', () => { h.busyOp = 'update'; }, "operation 'update' is running"],
    ['a backup', () => { h.backupBusy = true; }, 'a backup or restore is running on this database'],
    ['a shutdown', () => { h.shutting = true; }, 'the manager is shutting down'],
    ['an unreadable join code', () => { h.noJoin = true; }, 'the stored join code cannot be read'],
    ['a cancelled automatic run', () => writeRegistry({ fleetDbReplicaSeed: seed(clock - 5 * 3600_000, { parked: true, auto: true, cancelled: true }) }), 'a stopped re-seed is on record; the operator decides it'],
  ])('%s', async (_n, arrange, reason) => {
    arrange();
    expect(await computeVerdict(bot(), clock)).toEqual({ kind: 'wait', reason });
  });

  it('a cleared copy is not read, and is rebuilt while its database does not answer', async () => {
    writeRegistry({ fleetDbReplica: { ...REPLICA, copyCleared: true } });
    docker.copy = null;
    expect(await computeVerdict(bot(), clock)).toEqual({ kind: 'rebuild', slot: 'absent' });
  });

  it('a streaming copy and a copy that does not answer leave the main unread', async () => {
    docker.copy = 'true|streaming|7001|1|0/4000000';
    expect(await computeVerdict(bot(), clock)).toEqual({ kind: 'ok' });
    docker.copy = null;
    expect((await computeVerdict(bot(), clock)).kind).toBe('unknown');
    expect(fetches).toBe(0);
  });
});

describe('the log of a verdict', () => {
  it('logs a held or unknown verdict once, and again when it changes', async () => {
    docker.main.timeline = 2;
    await runFleetCopyTick(clock);
    await runFleetCopyTick(clock + 6 * 60_000);
    certSource.fetch = async () => ({ ok: false, reason: 'timeout' });
    await runFleetCopyTick(clock + 12 * 60_000);
    await runFleetCopyTick(clock + 18 * 60_000);
    const got = lines(warn);
    expect(got).toHaveLength(2);
    expect(got[0]).toBe(`[FleetCopy] B: the copy needs a rebuild but was not rebuilt automatically: ${TIMELINE2}`);
    expect(got[1]).toMatch(/^\[FleetCopy\] B: Can't confirm whether the main still keeps this copy's place: .*timeout/);
  });

  it('logs nothing for a copy that is fine', async () => {
    docker.copy = 'true|streaming|7001|1|0/4000000';
    await runFleetCopyTick(clock);
    expect(lines(warn)).toEqual([]);
  });

  it('a machine with no copy record drops its last verdict', async () => {
    docker.main.timeline = 2;
    await runFleetCopyTick(clock);
    expect(lastVerdict('b')?.verdict.kind).toBe('held');
    writeRegistry({ fleetDbReplica: undefined });
    await runFleetCopyTick(clock + 6 * 60_000);
    expect(lastVerdict('b')).toBeNull();
  });
});

describe('the owner message cases', () => {
  it('a rebuild verdict ends a held case', async () => {
    writeRegistry({ fleetCopyAlerts: { held: { kind: 'held', text: 'x', since: 1, dm: 'sent', dmAt: 1 } } });
    await runFleetCopyTick(clock);
    expect(bot().fleetCopyAlerts?.held).toBeUndefined();
  });

  it('a held reason that changes is stored with its new text, without a second message', async () => {
    docker.main.timeline = 2;
    await runFleetCopyTick(clock);
    docker.main.timeline = 3;
    await runFleetCopyTick(clock + 6 * 60_000);
    expect(h.sent).toHaveLength(1);
    expect(bot().fleetCopyAlerts?.held?.text).toContain('the main is on timeline 3');
  });

  it('an unchanged case and a case that stays off write nothing', async () => {
    docker.copy = 'true|streaming|7001|1|0/4000000';
    await runFleetCopyTick(clock);
    expect(h.saves).toBe(0);
    docker.copy = 'true||7001|1|0/4000000';
    docker.main.timeline = 2;
    await runFleetCopyTick(clock + 6 * 60_000);
    const saves = h.saves;
    await runFleetCopyTick(clock + 12 * 60_000);
    expect(h.saves).toBe(saves);
  });

  it.each([
    ['a cancelled run', { auto: true, cancelled: true }, {}],
    ['an operator run on a copy not cleared', {}, {}],
    ['a run whose copy was built', { auto: true }, { seededBy: 1000 }],
  ])('%s sends no stopped message', async (_n, over, rec) => {
    writeRegistry({ fleetDbReplica: { ...REPLICA, ...rec }, fleetDbReplicaSeed: seed(1000, { committed: true, parked: true, lastError: 'x', ...over }) });
    await runFleetCopyTick(clock);
    expect(h.sent.filter(t => t.includes('stopped after the old copy was deleted'))).toEqual([]);
  });

  it('an automatic run on a copy not cleared that stopped after the delete sends the stopped message, naming a missing cause', async () => {
    writeRegistry({ fleetDbReplicaSeed: seed(clock - 5 * 60_000, { committed: true, parked: true, auto: true }) });
    await runFleetCopyTick(clock);
    expect(h.sent).toEqual([expect.stringMatching(/^The automatic rebuild of the live database copy on copy\.invalid stopped after the old copy was deleted: it stopped\. /)]);
  });

  it('a machine holding the main gets no message', async () => {
    writeRegistry({ fleetDb: FLEETDB });
    await stepCopyAlerts(bot(), { held: { on: true, text: 'x' }, stopped: null }, clock);
    expect(h.sent).toEqual([]);
    expect(h.saves).toBe(0);
  });

  it('logs the outcome of a send, with and without an error', async () => {
    docker.main.timeline = 2;
    h.notify = { dm: 'failed', dmError: 'bot down' };
    await runFleetCopyTick(clock);
    h.notify = { dm: 'sent' };
    await runFleetCopyTick(clock + 61 * 60_000);
    expect(lines(log)).toEqual([
      '[FleetCopy] Message to the owner of B about the copy (held): failed (bot down)',
      '[FleetCopy] Message to the owner of B about the copy (held): sent',
    ]);
  });

  it('a case ended during the send is left ended, and the check goes on', async () => {
    docker.main.timeline = 2;
    h.onSend = () => containerManager.updateInstanceFleetCopyAlert('b', 'held', null);
    await runFleetCopyTick(clock);
    expect(bot().fleetCopyAlerts?.held).toBeUndefined();
    expect(lines(error)).toEqual([]);
  });
});

describe('a state that could not be saved', () => {
  it('is kept in memory for this machine only, logged, and dropped once a save works', async () => {
    docker.main.timeline = 2;
    h.saveFail = 'disk full';
    await runFleetCopyTick(clock);
    expect(lines(error)[0]).toBe('[FleetCopy] The owner message state held of B could not be saved, so a manager restart may send it again (disk full)');
    expect(Object.keys(rebuildView(bot())!.alerts as object)).toEqual(['held']);
    expect(rebuildView({ ...bot(), id: 'z' })!.alerts).toEqual({});
    await runFleetCopyTick(clock + 6 * 60_000);
    expect(h.sent).toHaveLength(1);
    h.saveFail = '';
    docker.copy = 'true|streaming|7001|1|0/4000000';
    await runFleetCopyTick(clock + 12 * 60_000);
    expect(rebuildView(bot())!.alerts).toEqual({});
  });
});

describe('the tick', () => {
  it('leaves a busy machine alone', async () => {
    h.busyOp = 'update';
    await runFleetCopyTick(clock);
    expect(envManager.getEnvVars('b').DATA_BACKEND_URL).toBeUndefined();
  });

  it('does not read the address list of a machine that holds the main', async () => {
    writeRegistry({ fleetJoin: fakeJoinRecord({ addressesReadAt: clock - 3600_000 }), fleetDb: FLEETDB, fleetDbReplica: undefined });
    await runFleetCopyTick(clock);
    expect(docker.events).not.toContain('address-read');
  });

  it('logs a Database URL that could not be written and goes on', async () => {
    h.envFail = 'disk full';
    docker.main.timeline = 2;
    await runFleetCopyTick(clock);
    expect(lines(warn)[0]).toBe('[FleetCopy] B: the Database URL could not be written: disk full');
    expect(h.sent).toHaveLength(1);
  });

  it('logs an address list that could not be refreshed', async () => {
    writeRegistry({ fleetJoin: fakeJoinRecord({ addressesReadAt: clock - 3600_000 }) });
    h.refreshFail = 'boom';
    docker.copy = 'true|streaming|7001|1|0/4000000';
    await runFleetCopyTick(clock);
    expect(lines(warn)).toEqual(['[FleetCopy] B: the address list could not be refreshed: boom']);
  });

  it('does not write the list again after a refresh when the machine became busy', async () => {
    writeRegistry({ fleetJoin: fakeJoinRecord({ addressesReadAt: clock - 3600_000 }) });
    docker.copy = 'true|streaming|7001|1|0/4000000';
    h.afterRefresh = () => { h.busyOp = 'update'; };
    await runFleetCopyTick(clock);
    expect(h.envWrites).toBe(1);
  });

  it('logs a check that failed', async () => {
    h.copyThrow = 'socket closed';
    await expect(runFleetCopyTick(clock)).resolves.toBeUndefined();
    expect(lines(error)).toEqual(['[FleetCopy] B: the check failed: socket closed']);
  });

  it('a tick started while one runs does nothing', async () => {
    docker.main.timeline = 2;
    let release!: () => void;
    h.gate = new Promise<void>(r => { release = r; });
    const first = runFleetCopyTick(clock);
    for (let i = 0; i < 1000 && h.sent.length === 0; i++) await new Promise(r => setTimeout(r, 5));
    const writes = h.envWrites;
    await runFleetCopyTick(clock + 1);
    expect(h.envWrites).toBe(writes);
    release();
    await first;
  });
});

describe('the rebuild start', () => {
  it('re-checks the facts inside the lock', async () => {
    await runFleetCopyTick(clock);
    expect(h.lockCheck).not.toBeNull();
    expect(await h.lockCheck!()).toBe(true);
    docker.main.timeline = 2;
    expect(await h.lockCheck!()).toBe(false);
  });

  it('logs a rebuild that did not start, and nothing for one that did', async () => {
    await runFleetCopyTick(clock);
    expect(lines(warn)).toEqual([]);
    h.startReason = 'a seed is running';
    await runFleetCopyTick(clock + 6 * 60_000);
    expect(lines(warn)).toEqual(['[FleetCopy] B: the rebuild did not start: a seed is running']);
  });
});

describe('the timers', () => {
  it('ticks after a minute, then every 5 minutes, once however often it is started, and not after a stop', async () => {
    fs.writeFileSync(REGISTRY, JSON.stringify({ instances: {} }));
    vi.useFakeTimers();
    startFleetCopyWatch();
    startFleetCopyWatch();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.allCalls).toBe(1);
    startFleetCopyWatch();
    await vi.advanceTimersByTimeAsync(300_000);
    expect(h.allCalls).toBe(2);
    stopFleetCopyWatch();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(h.allCalls).toBe(2);
  });
});

describe('the Database window', () => {
  it('counts no addresses when none were read, and names an unreadable code', () => {
    writeRegistry({ fleetJoin: { ...fakeJoinRecord(), addresses: undefined } });
    expect(joinView(bot())).toMatchObject({ addressCount: 0, codeUnreadable: false });
    h.noJoin = true;
    expect(joinView(bot())).toMatchObject({ codeUnreadable: true });
  });

  it('shows the copy record and its hold with no messages stored', () => {
    writeRegistry({ fleetDbReplica: { ...REPLICA, autoRebuildHeldAt: '2026-10-20T00:00:00.000Z' } });
    expect(rebuildView(bot())).toMatchObject({ heldAt: '2026-10-20T00:00:00.000Z', alerts: {} });
  });
});
