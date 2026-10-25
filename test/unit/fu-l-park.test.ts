import { beforeEach, describe, expect, it, vi } from 'vitest';

// The drop-back park's own lift (the runner's exit when the lane is no longer ended), with the lift answered by hand.
const st = vi.hoisted(() => ({
  bots: [] as any[],
  read: null as any,
  posture: null as any,
  lift: 'lifted' as string,
  holder: null as string | null,
  lifts: 0,
  gate: null as Promise<void> | null,
  entered: null as (() => void) | null,
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
  },
  updateInstanceFleetLastPosture: () => undefined,
  broadcastBotUpdated: () => undefined,
  stopBot: async () => ({ success: true }),
  startBot: async () => ({ success: true }),
}));
vi.mock('../../src/instance/appHookClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/instance/appHookClient')>()),
  hasAppHooks: () => true,
}));
vi.mock('../../src/instance/appLifecycle', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/instance/appLifecycle')>()),
  getAppFacts: async () => st.read,
  postureFromRead: () => st.posture,
}));
vi.mock('../../src/instance/fleetBackup', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/instance/fleetBackup')>()),
  fenceLayers: async () => ({ readOnly: false, hba: false }),
  fenceForConsent: async () => ({ ok: true as const }),
  liftConsentFence: async (_id: string, _t: unknown, _o: string, _r: string, _l: unknown, held: any) => {
    st.lifts++;
    st.entered?.();
    if (st.gate) await st.gate;
    if (st.lift === 'held') Object.assign(held, { readOnly: true, hba: false, holder: st.holder });
    return st.lift;
  },
  failbackFenceLeft: () => false,
}));

import * as fleetBackupGuards from '../../src/instance/fleetBackupGuards';
import { cancelFailback, continueFailback } from '../../src/instance/fleetFailback';

const copy = { containerName: 'copy-b1', user: 'u', db: 'd', volume: 'copy-vol-b1' };
const dropBack = (): any => ({
  id: 'b1', displayName: 'Bot one', status: 'stopped', fleetDbReplica: copy,
  fleetFailback: {
    mode: 'drop-back', phase: 'awaiting-block', startedAt: 1, updatedAt: 1, standInNodeId: 'node-abcdef12', episode: 3,
    lineage: null, dump: null, consentAt: null, block: null, serve: null, stoppedByRun: false, parked: true, lastError: 'x',
    fence: { ok: true, error: null, at: 1, owned: true },
  },
});
const live = (): any => st.bots[0];
const parkedWith = async (): Promise<string> => {
  await vi.waitFor(() => expect(live().fleetFailback.parked).toBe(true));
  return live().fleetFailback.lastError as string;
};

beforeEach(() => {
  fleetBackupGuards.releaseFleetBackupBusy('b1');
  st.read = { success: true, facts: { running: true, initialized: true } };
  st.posture = { read: 'ok', posture: { role: 'covered' } };
  st.lift = 'lifted';
  st.holder = null;
  st.lifts = 0;
  st.gate = null;
  st.entered = null;
  st.bots = [dropBack()];
});

describe('FU-L row 3: the park\'s text names the lane that holds a layer, not a retry', () => {
  it('a layer a restore holds names the restore and what lifts it, and promises no retry', async () => {
    st.lift = 'held';
    st.holder = 'restore:1729900000000';
    expect((await continueFailback(live())).success).toBe(true);
    const err = await parkedWith();
    expect(err).toBe('the bot no longer reports this copy as an ended stand-in lane; nothing has been changed; the database is READ-ONLY: the read-only layer of the write fence belongs to a restore (started 2024-10-25 23:46 UTC), so the run left it on; running that lane again lifts it');
    expect(err).not.toMatch(/retries the lift/);
    expect(live().fleetFailback.fence).toMatchObject({ ok: true, owned: true });
    expect(st.lifts).toBe(1);
  });

  it('a lift that failed still names its retry', async () => {
    st.lift = 'failed';
    expect((await continueFailback(live())).success).toBe(true);
    expect(await parkedWith()).toMatch(/\(re-seeding this copy on its Database modal clears it\) \(Continue or Dismiss retries the lift\)$/);
  });
});

describe('FU-L row 4: the park\'s own lift waits for the backup slot', () => {
  it('a slot another lane holds keeps the lift from running, and the park says why and keeps the fence on the run', async () => {
    expect(fleetBackupGuards.claimFleetBackupBusy('b1')).toBe(true);
    expect((await continueFailback(live())).success).toBe(true);
    const err = await parkedWith();
    fleetBackupGuards.releaseFleetBackupBusy('b1');
    expect(err).toBe('the bot no longer reports this copy as an ended stand-in lane; nothing has been changed; its write fence was not lifted, because another database operation holds the backup slot of this instance (Continue or Dismiss retries the lift)');
    expect(st.lifts).toBe(0);
    expect(live().fleetFailback.fence).toMatchObject({ ok: true, owned: true });
  });
});

describe('FU-L row 5: a Cancel during the run\'s own fence lift names that lift', () => {
  it('Cancel while the runner lifts its own fence says so and changes nothing', async () => {
    let open!: () => void;
    st.gate = new Promise<void>(r => { open = r; });
    const inLift = new Promise<void>(r => { st.entered = r; });
    expect((await continueFailback(live())).success).toBe(true);
    await inLift;
    const r = await cancelFailback(live());
    open();
    expect(r).toEqual({ success: false, error: 'Cancel was refused because the run is lifting its own write fence; nothing was changed. Cancel again in a moment' });
    await parkedWith();
    expect(fleetBackupGuards.isFleetBackupBusy('b1')).toBe(false);
  });
});
