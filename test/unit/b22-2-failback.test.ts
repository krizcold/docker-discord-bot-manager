import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const st = vi.hoisted(() => ({
  bots: [] as any[],
  read: null as any,
  refuse: false,
  restart: { success: true } as { success: boolean; error?: string },
}));

vi.mock('../../src/webui/server', () => ({ broadcastToClients: () => {} }));
vi.mock('../../src/docker/containerManager', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/docker/containerManager')>()),
  getAllBots: () => st.bots,
  getBot: (id: string) => st.bots.find(b => b.id === id) ?? null,
  updateInstanceFleetFailback: (id: string, run: any) => {
    if (st.refuse) throw new Error('ENOSPC: no space left on device');
    const b = st.bots.find(x => x.id === id);
    if (b) b.fleetFailback = run;
  },
  updateInstanceFleetFailbackDeclined: (id: string, rec: any) => {
    if (st.refuse) throw new Error('ENOSPC: no space left on device');
    const b = st.bots.find(x => x.id === id);
    if (b) b.fleetFailbackDeclined = rec;
  },
  updateInstanceFleetLastPosture: () => undefined,
  broadcastBotUpdated: () => undefined,
  restartBot: async () => { await new Promise(r => setImmediate(r)); return st.restart; },
  withServingStatus: async (record: any) => ({ instance: record, unanswered: false }),
}));
vi.mock('../../src/instance/appHookClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/instance/appHookClient')>()),
  hasAppHooks: () => true,
}));
vi.mock('../../src/instance/appLifecycle', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/instance/appLifecycle')>()),
  getAppFacts: async () => st.read,
  postureFromRead: () => null,
}));
vi.mock('../../src/instance/fleetBackup', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/instance/fleetBackup')>()),
  liftConsentFence: async () => 'lifted',
  failbackFenceLeft: () => false,
}));

import { continueFailback, dismissFailback, failbackView, retryHeldFailbackRecords, stoppedText } from '../../src/instance/fleetFailback';
import { databaseLaneBlocker } from '../../src/instance/fleetBackup';
import { removeFleetReplica } from '../../src/instance/fleetReplica';
import { getReplicationHealth, startFleetReplicationHealth, stopFleetReplicationHealth } from '../../src/instance/fleetReplicationHealth';

const flush = async (n = 20): Promise<void> => { for (let i = 0; i < n; i++) await new Promise(r => setImmediate(r)); };

const run = (extra: Record<string, unknown> = {}): any => ({
  mode: 'failback', phase: 'restarting', startedAt: 7, updatedAt: 1, standInNodeId: 'node-abcdef12',
  episode: 3, lineage: null, dump: null, consentAt: 2, block: null, serve: null, stoppedByRun: false,
  handoverAt: 3, adoptedAt: 4, parked: true, lastError: 'the instance could not be restarted onto its database: busy', fence: null,
  ...extra,
});
const bot = (extra: Record<string, unknown> = {}): any => ({
  id: 'f1', displayName: 'Bot one', status: 'running',
  fleetDb: { containerName: 'db-f1', user: 'u', db: 'd', volume: 'vol-f1' },
  ...extra,
});
const live = (): any => st.bots[0];

afterEach(async () => { await flush(); });

beforeEach(() => {
  st.bots = [];
  st.refuse = false;
  st.read = { success: true, facts: { running: true, initialized: true, role: 'master' } };
  st.restart = { success: true };
});

describe('R39-J2: a failback whose park write is refused keeps its levers', () => {
  it('holds the park in memory, reads it as stopped, and lets Dismiss close it', async () => {
    st.bots = [bot({ fleetFailback: run() })];
    st.restart = { success: false, error: 'docker busy' };
    const cont = await continueFailback(live());
    expect(cont.success).toBe(true);
    st.refuse = true;
    await flush();
    const view = failbackView(live())!;
    expect(view.parked).toBe(true);
    expect(view.lastError).toMatch(/^the run stopped at .*: the instance could not be restarted onto its database: docker busy; its record could not be written \(ENOSPC/);
    expect(live().fleetFailback.parked).toBe(false);
    st.refuse = false;
    const dismissed = await dismissFailback(live());
    expect(dismissed.success).toBe(true);
    expect(live().fleetFailback).toBeNull();
  });

  it('reads a live record with no runner as stopped, so Continue is offered', async () => {
    st.bots = [bot({ fleetFailback: run({ phase: 'adopting', parked: false, lastError: undefined }) })];
    const view = failbackView(live())!;
    expect(view.parked).toBe(true);
    expect(view.lastError).toMatch(/runner stopped/);
    st.restart = { success: false, error: 'docker busy' };
    const cont = await continueFailback(live(), {});
    expect(cont.success).toBe(true);
  });
});

describe('R40-J3: a failback whose success clear is refused reads finished', () => {
  it('names the pending clear, refuses Continue, and the health tick clears it', async () => {
    st.bots = [bot({ fleetFailback: run() })];
    const cont = await continueFailback(live());
    expect(cont.success).toBe(true);
    st.refuse = true;
    await flush();
    const view = failbackView(live())!;
    expect(view.finished).toBe(true);
    expect(view.lastError).toMatch(/finished.*could not be cleared \(ENOSPC/);
    const again = await continueFailback(live());
    expect(again.success).toBe(false);
    expect(again.error).toMatch(/finished/);
    st.refuse = false;
    retryHeldFailbackRecords();
    expect(live().fleetFailback).toBeNull();
    expect(live().fleetFailbackDeclined).toBeUndefined();
  });
});

describe('B22-2: a finished run whose clear is refused states the finish once', () => {
  it('the card and the stopped badge name the finish once, in sentence case', async () => {
    st.bots = [bot({ fleetFailback: run() })];
    const cont = await continueFailback(live());
    expect(cont.success).toBe(true);
    st.refuse = true;
    await flush();
    const view = failbackView(live())!;
    expect(view.lastError!.match(/finished/g)).toHaveLength(1);
    const badge = stoppedText(view);
    expect(badge.match(/finished/g)).toHaveLength(1);
    expect(badge).not.toMatch(/; [A-Z]/);
    expect(badge).toMatch(/^Instance is stopped; the failback finished, but its run record is not cleared yet/);
    expect(badge).toMatch(/Dismiss/);
    st.refuse = false;
    retryHeldFailbackRecords();
  });
});

describe('R39-J2: the by-hand lanes and the badge read a stopped run as stopped', () => {
  it('a live record with no runner is refused with its exits, not a wait', async () => {
    st.bots = [bot({ fleetFailback: run({ phase: 'adopting', parked: false, lastError: undefined }) })];
    const r = await removeFleetReplica(live());
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/stopped \(/);
    expect(r.error).toMatch(/Continue/);
    expect(r.error).not.toMatch(/wait for it to park or finish/);
  });

  it("the run's own first step is not refused as a stopped run", async () => {
    st.bots = [bot({ fleetFailback: run({ mode: 'drop-back', phase: 'seeding', lastError: 'x' }) })];
    const cont = await continueFailback(live());
    expect(cont.success).toBe(true);
    await flush();
    expect(live().fleetFailback.lastError).not.toMatch(/that asked was stopped/);
    expect(live().fleetFailback.lastError).toMatch(/no standby to re-seed/);
  });

  it('the stopped badge says the run stopped when it has no runner', async () => {
    st.bots = [bot({ status: 'stopped', fleetDb: { containerName: 'db-f1', user: 'u', db: 'd', volume: 'vol-f1', replication: { enabled: true } }, fleetFailback: run({ phase: 'adopting', parked: false, stoppedByRun: true, lastError: undefined }) })];
    startFleetReplicationHealth();
    try {
      await vi.waitFor(() => expect(getReplicationHealth('f1')).toBeTruthy());
    } finally {
      stopFleetReplicationHealth();
    }
    const msg = getReplicationHealth('f1')!.message;
    expect(msg).toMatch(/^Instance is stopped by the failback run \(.*\); the run stopped: the run's runner stopped/);
  });
});

describe('R39-J2: the self-update reads a failback with no runner as stopped', () => {
  it('does not name a running run', () => {
    st.bots = [bot({ fleetFailback: run({ phase: 'adopting', parked: false, lastError: undefined }) })];
    expect(databaseLaneBlocker()).toBeNull();
  });
});
