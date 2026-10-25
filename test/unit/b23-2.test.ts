import { beforeEach, describe, expect, it, vi } from 'vitest';

const st = vi.hoisted(() => ({
  bots: [] as any[],
  read: null as any,
  posture: null as any,
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
  broadcastBotUpdated: () => undefined,
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

import { consentText, openFailbackByHand, parkInterruptedFailbacks, stoppedText } from '../../src/instance/fleetFailback';
import { removeFleetReplica } from '../../src/instance/fleetReplica';

const run = (extra: Record<string, unknown> = {}): any => ({
  mode: 'failback', phase: 'wipe-consent', startedAt: 1, updatedAt: 1, standInNodeId: 'node-abcdef12',
  episode: 3, lineage: null, dump: null, consentAt: null, block: null, serve: null, stoppedByRun: false, parked: true,
  ...extra,
});
const bot = (extra: Record<string, unknown> = {}): any => ({ id: 'b1', displayName: 'Bot one', status: 'stopped', ...extra });

beforeEach(() => {
  st.bots = [];
  st.read = { success: true, facts: { running: true, initialized: true } };
  st.posture = null;
});

describe('R4-J23: the consent and stopped texts follow stoppedByRun', () => {
  it('Cancel promises a restart only when the run stopped the instance', () => {
    expect(consentText(run({ stoppedByRun: true }))).toMatch(/Cancel starts the instance again with the database untouched/);
    const text = consentText(run({ stoppedByRun: false }));
    expect(text).not.toMatch(/starts the instance again/);
    expect(text).toMatch(/Cancel leaves the instance stopped, as it was, with the database untouched/);
  });

  it('the badge says the run stopped the instance only when it did', () => {
    expect(stoppedText(run({ stoppedByRun: true }))).toMatch(/^Instance is stopped by the failback run/);
    expect(stoppedText(run({ stoppedByRun: false }))).toMatch(/^Instance is stopped; a failback run is on record/);
    expect(stoppedText(run({ stoppedByRun: false }))).not.toMatch(/not by the failback run/);
    expect(stoppedText(run({ stoppedByRun: false, phase: 'seeding', consentAt: 2 }))).toMatch(/^Instance is stopped; a failback run is on record \(/);
  });
});

describe('R20-J9: the restart park names the exit its state offers', () => {
  it('a seeding run whose seed is parked names the seed dismissal, not a plain Continue', () => {
    st.bots = [bot({ fleetFailback: run({ phase: 'seeding', parked: false, consentAt: 2 }), fleetDbReplicaSeed: { parked: true, phase: 'seeding', startedAt: 5 } })];
    parkInterruptedFailbacks();
    const err = st.bots[0].fleetFailback.lastError as string;
    expect(err).toMatch(/dismiss the seed on this modal, then Continue seeds again/);
    expect(err).not.toMatch(/Continue picks up from where it stopped/);
  });

  it('any other interrupted run keeps the plain Continue', () => {
    st.bots = [bot({ fleetFailback: run({ phase: 'awaiting-block', parked: false }) })];
    parkInterruptedFailbacks();
    expect(st.bots[0].fleetFailback.lastError).toMatch(/Continue picks up from where it stopped$/);
  });
});

describe('R40-J11: the run hold names the exits the run offers', () => {
  it('a live run is waited on, with no button promised', async () => {
    const r = await removeFleetReplica(bot({ fleetFailback: run({ phase: 'seeding', parked: false, consentAt: 2 }) }));
    expect(r.error).toMatch(/failback run is on this instance/);
    expect(r.error).toMatch(/wait for it to park or finish/);
    expect(r.error).not.toMatch(/Continue|Cancel|Dismiss/);
  });

  it('a consent park names its own two answers', async () => {
    const r = await removeFleetReplica(bot({ fleetFailback: run() }));
    expect(r.error).toMatch(/answer it on the Database modal first \(Wipe and re-seed, or Cancel\)/);
    expect(r.error).not.toMatch(/Dismiss/);
  });

  it('a park past the wipe does not offer Cancel', async () => {
    const r = await removeFleetReplica(bot({ fleetFailback: run({ phase: 'adopting', consentAt: 2, handoverAt: 3 }) }));
    expect(r.error).toMatch(/Continue or Dismiss it on the Database modal first/);
    expect(r.error).not.toMatch(/Cancel/);
  });

  it('a cancelable park offers all three', async () => {
    const r = await removeFleetReplica(bot({ fleetFailback: run({ phase: 'awaiting-block' }) }));
    expect(r.error).toMatch(/Continue, Cancel or Dismiss it/);
  });
});

describe('R41-J8: the by-hand refusal names the decline and the managed-database gate first', () => {
  const covered = (extra: Record<string, unknown> = {}) => ({ read: 'ok', posture: { role: 'covered', namesThisNode: undefined, standInNodeId: 'node-abcdef12', holdReason: 'behind', ...extra } });

  it('a hand-deployed database is named before the registration wait', async () => {
    st.posture = covered();
    st.bots = [bot()];
    const r = await openFailbackByHand(st.bots[0]);
    expect(r.error).toMatch(/manages no database on this instance/);
    expect(r.error).not.toMatch(/opens once it has/);
  });

  it('a standing decline is named instead of an automatic opening', async () => {
    st.posture = covered();
    st.bots = [bot({ fleetDb: { containerName: 'c' }, fleetFailbackDeclined: { mode: 'failback', at: 1, standInNodeId: 'node-abcdef12' } })];
    const r = await openFailbackByHand(st.bots[0]);
    expect(r.error).toMatch(/stays declined for this stand-in episode; press Fail back now again once the bot has registered/);
    expect(r.error).not.toMatch(/opens once it has/);
  });

  it('a decline that does not apply to this episode promises the automatic opening', async () => {
    for (const d of [{ mode: 'drop-back', at: 1 }, { mode: 'failback', at: 1, standInNodeId: 'node-other999' }]) {
      st.posture = covered();
      st.bots = [bot({ fleetDb: { containerName: 'c' }, fleetFailbackDeclined: d })];
      const r = await openFailbackByHand(st.bots[0]);
      expect(r.error).toMatch(/the failback opens once it has/);
      expect(r.error).not.toMatch(/stays declined/);
    }
  });

  it('with no decline and a managed database the automatic opening is promised', async () => {
    st.posture = covered();
    st.bots = [bot({ fleetDb: { containerName: 'c' } })];
    const r = await openFailbackByHand(st.bots[0]);
    expect(r.error).toMatch(/the failback opens once it has/);
  });
});
