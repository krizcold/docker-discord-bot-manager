import { beforeEach, describe, expect, it, vi } from 'vitest';

const st = vi.hoisted(() => ({
  bots: [] as any[],
  refuse: false,
  promotes: 0,
}));

vi.mock('../../src/webui/server', () => ({ broadcastToClients: () => {} }));
vi.mock('../../src/docker/containerManager', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/docker/containerManager')>()),
  getAllBots: () => st.bots,
  getBot: (id: string) => st.bots.find(b => b.id === id) ?? null,
  updateInstanceFleetTransfer: (id: string, run: any) => {
    if (st.refuse) throw new Error('ENOSPC: no space left on device');
    const b = st.bots.find(x => x.id === id);
    if (b) b.fleetTransfer = run ?? undefined;
  },
  broadcastBotUpdated: () => undefined,
  startBot: async () => ({ success: false, error: 'compose up failed' }),
  markPendingApplyIfRunning: async () => undefined,
}));
vi.mock('../../src/instance/appHookClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/instance/appHookClient')>()),
  hasAppHooks: () => true,
}));
vi.mock('../../src/instance/appLifecycle', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/instance/appLifecycle')>()),
  getAppFacts: async () => ({ success: false, error: 'no answer' }),
  transfer: async () => { st.promotes++; return { success: true }; },
}));

import { dismissTransfer, retryHeldTransferRecords, transferSide, transferView } from '../../src/instance/fleetTransfer';
import { databaseLaneBlocker } from '../../src/instance/fleetBackup';

const flush = async (n = 20): Promise<void> => { for (let i = 0; i < n; i++) await new Promise(r => setImmediate(r)); };

const bot = (run: any): any => ({
  id: 't1', displayName: 'Bot one', status: 'stopped',
  fleetDbReplica: { containerName: 'copy-t1' },
  fleetTransfer: run,
});
const live = (): any => st.bots[0];

beforeEach(() => {
  st.bots = [];
  st.refuse = false;
  st.promotes = 0;
});

describe('R41-J4: a Continue transfer whose promote was accepted answers truthfully when its record clear is refused', () => {
  it('answers success with a warning, holds the note, hides Continue and lets Dismiss clear it', async () => {
    st.bots = [bot({ phase: 'promoting', startedAt: 5, updatedAt: 5, retireOldMaster: false, parked: true, lastError: 'the app refused the promote' })];
    st.refuse = true;
    const result = await transferSide(live(), {});
    expect(result.success).toBe(true);
    expect((result as any).warning).toMatch(/accepted the promote.*could not be cleared \(ENOSPC/);
    const view = transferView(live())!;
    expect(view.clearPending).toBe(true);
    expect(view.lastError).toMatch(/^Handed to the app at /);
    const again = await transferSide(live(), {});
    expect(again.success).toBe(false);
    expect(st.promotes).toBe(1);
    st.refuse = false;
    expect(dismissTransfer(live()).success).toBe(true);
    expect(live().fleetTransfer).toBeUndefined();
  });

  it('retries the pending clear on the health tick', async () => {
    st.bots = [bot({ phase: 'promoting', startedAt: 6, updatedAt: 6, retireOldMaster: false, parked: true })];
    st.refuse = true;
    await transferSide(live(), {});
    st.refuse = false;
    retryHeldTransferRecords();
    expect(live().fleetTransfer).toBeUndefined();
    expect(transferView(live())).toBeNull();
  });
});

describe('R39-J2: a transfer runner whose park write is refused keeps its levers', () => {
  it('holds the park, reads it as stopped and lets Dismiss close it', async () => {
    st.bots = [bot({ phase: 'catching-up', startedAt: 8, updatedAt: 8, retireOldMaster: false, parked: true })];
    const started = await transferSide(live(), {});
    expect(started.success).toBe(true);
    st.refuse = true;
    await flush();
    const view = transferView(live())!;
    expect(view.parked).toBe(true);
    expect(view.lastError).toMatch(/the app could not be started with its standby: compose up failed; its record could not be written \(ENOSPC/);
    st.refuse = false;
    expect(dismissTransfer(live()).success).toBe(true);
  });

  it('reads a live record with no runner as stopped', () => {
    st.bots = [bot({ phase: 'applying', startedAt: 9, updatedAt: 9, retireOldMaster: false })];
    const view = transferView(live())!;
    expect(view.parked).toBe(true);
    expect(view.lastError).toMatch(/runner stopped/);
  });
});

describe('R39-J2: the self-update reads a transfer with no runner as stopped', () => {
  it('does not name a running transfer', () => {
    st.bots = [bot({ phase: 'promoting', startedAt: 5, updatedAt: 5, retireOldMaster: false })];
    expect(databaseLaneBlocker()).toBeNull();
  });
});
