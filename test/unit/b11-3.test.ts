import { beforeEach, describe, expect, it, vi } from 'vitest';

const st = vi.hoisted(() => ({
  bots: [] as any[],
  unanswered: false,
  primary: null as any,
  replica: null as any,
  facts: null as any,
  writes: 0,
  failWrite: false,
}));

vi.mock('../../src/docker/containerManager', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/docker/containerManager')>()),
  getAllBots: () => st.bots,
  getBot: (id: string) => st.bots.find(b => b.id === id) ?? null,
  withServingStatus: async (record: any) => ({ instance: record, unanswered: st.unanswered }),
  storedStatus: (i: any) => i.status,
  updateInstanceFleetLastPosture: (id: string, rec: any) => {
    st.writes++;
    if (st.failWrite) throw new Error('ENOSPC');
    const b = st.bots.find(x => x.id === id);
    if (!b) return;
    if (rec) b.fleetLastPosture = rec; else delete b.fleetLastPosture;
  },
}));
vi.mock('../../src/instance/fleetReplication', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/instance/fleetReplication')>()),
  getFleetReplicationStatus: async () => st.primary,
}));
vi.mock('../../src/instance/fleetReplica', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/instance/fleetReplica')>()),
  getFleetReplicaStatus: async () => st.replica,
  publishStandInCopyBlock: async () => undefined,
}));
vi.mock('../../src/instance/fleetFailback', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/instance/fleetFailback')>()),
  settleDecline: () => undefined,
  noteHandover: () => undefined,
  maybeOpenFailback: () => undefined,
  maybeOpenDropBack: () => undefined,
  activeDecline: () => null,
}));
vi.mock('../../src/instance/appHookClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/instance/appHookClient')>()),
  hasAppHooks: () => true,
}));
vi.mock('../../src/instance/appLifecycle', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/instance/appLifecycle')>()),
  getAppFacts: async () => st.facts,
}));

import { getReplicationHealth, startFleetReplicationHealth, stopFleetReplicationHealth } from '../../src/instance/fleetReplicationHealth';

const covered = {
  role: 'covered', live: true, standInNodeId: 'abcdef1234567890', coveringNodeId: null, holdsWrites: null, since: null,
  gate: null, disarmReason: null, holdReason: 'behind', namesThisNode: true, followsDelivered: true,
};
const coveredFacts = { success: true, facts: { running: true, nodeId: 'n1', followerHold: { reason: 'behind', standInNodeId: covered.standInNodeId, namesThisNode: true, following: 'x' } } };
const streamingPrimary = { enabled: true, live: { sslOn: true, standbys: [], slots: [{ slot: 's1', fleet: true, walStatus: 'reserved', active: true, retainedBytes: 1, clientAddr: null, state: 'streaming', replayLagSeconds: 0 }], slotWalKeep: '4GB' } };
const streamingReplica = { live: { running: true, inRecovery: true, receiverStatus: 'streaming', replayLagSeconds: 0, caughtUp: true } };

const tick = async (): Promise<any> => {
  const before = getReplicationHealth('b1')?.checkedAt ?? -1;
  startFleetReplicationHealth();
  stopFleetReplicationHealth();
  let v: any = null;
  await vi.waitFor(() => { v = getReplicationHealth('b1'); expect(v && v.checkedAt !== before).toBe(true); });
  await new Promise(r => setTimeout(r, 5));
  return v;
};
const primaryBot = (extra: Record<string, unknown> = {}) => ({ id: 'b1', status: 'running', sourceType: 'git', fleetDb: { containerName: 'db', replication: {} }, ...extra });
const replicaBot = (extra: Record<string, unknown> = {}) => ({ id: 'b1', status: 'running', sourceType: 'git', fleetDbReplica: { containerName: 'copy', slot: 's1' }, ...extra });

beforeEach(async () => {
  st.unanswered = false;
  st.primary = streamingPrimary;
  st.replica = streamingReplica;
  st.facts = null;
  st.writes = 0;
  st.failWrite = false;
  st.bots = [];
  // An empty tick drops the previous row's cache, standing in for a manager restart.
  startFleetReplicationHealth();
  stopFleetReplicationHealth();
  await new Promise(r => setTimeout(r, 20));
});

describe('B11-3 a stopped covered primary', () => {
  it('keeps the covered verdict across a manager restart (R25-14)', async () => {
    st.bots = [primaryBot({ status: 'stopped', fleetLastPosture: { posture: covered, readAt: 1 } })];
    const v = await tick();
    expect(v.severity).toBe('warn');
    expect(v.standIn?.role).toBe('covered');
    expect(v.message).toContain('copy that is behind');
  });

  it('says the posture is unknown when nothing was ever read, never ok', async () => {
    st.bots = [primaryBot({ status: 'stopped' })];
    const v = await tick();
    expect(v.severity).toBe('warn');
    expect(v.message).toContain('unknown');
  });

  it('says plainly stopped when the last answered posture was none', async () => {
    st.bots = [primaryBot({ status: 'stopped', fleetLastPosture: { posture: null, readAt: 1 } })];
    const v = await tick();
    expect(v.severity).toBe('ok');
    expect(v.message).toBe('Instance is stopped');
  });

  it('records an answered covered posture on the instance record', async () => {
    st.bots = [primaryBot()];
    st.facts = coveredFacts;
    await tick();
    expect(st.bots[0].fleetLastPosture?.posture?.role).toBe('covered');
  });
});

describe('B11-3 an unanswered sample keeps the last read posture (R26-13, R26-14)', () => {
  it('a running covered primary whose app is silent is not given the slot verdict', async () => {
    st.bots = [primaryBot({ fleetLastPosture: { posture: covered, readAt: 1 } })];
    st.facts = { success: false, error: 'timeout' };
    const v = await tick();
    expect(v.message).not.toContain('Streaming to');
    expect(v.severity).toBe('warn');
    expect(v.standIn?.role).toBe('covered');
    expect(v.message).toContain('unknown');
    expect(st.bots[0].fleetLastPosture?.posture?.role).toBe('covered');
  });

  it('a running primary whose posture was never read and whose app is silent is not ok', async () => {
    st.bots = [primaryBot()];
    st.facts = { success: false, error: 'timeout' };
    const v = await tick();
    expect(v.severity).not.toBe('ok');
    expect(v.message).not.toContain('Streaming to');
    expect(v.message).toContain('unknown');
  });

  it('a covered standby whose app is silent is not called streaming ok', async () => {
    st.bots = [replicaBot({ fleetLastPosture: { posture: covered, readAt: 1 } })];
    st.facts = { success: false, error: 'timeout' };
    const v = await tick();
    expect(v.severity).toBe('warn');
    expect(v.standIn?.role).toBe('covered');
  });

  it('a down covered standby keeps its last read posture', async () => {
    st.bots = [replicaBot({ fleetLastPosture: { posture: covered, readAt: 1 } })];
    st.replica = { live: { running: false } };
    const v = await tick();
    expect(v.standIn?.role).toBe('covered');
    expect(v.message).toContain("returning master's copy");
  });

  it('a down standby uses the posture the same sample read', async () => {
    st.bots = [replicaBot()];
    st.replica = { live: { running: false } };
    st.facts = coveredFacts;
    const v = await tick();
    expect(v.standIn?.role).toBe('covered');
  });
});

describe('B11-3 review round', () => {
  const standInFacts = (gate: string) => ({ success: true, facts: { running: true, nodeId: 'n1', standIn: { coveringNodeId: 'm1', live: true, phase: 'armed', armedAt: 1, writeGate: gate } } });

  it('a gate countdown alone does not rewrite the record, and the stored gate is null', async () => {
    st.bots = [replicaBot()];
    st.facts = standInFacts('asking again in 5 min');
    await tick();
    st.facts = standInFacts('asking again in 4 min');
    await tick();
    expect(st.writes).toBe(1);
    expect(st.bots[0].fleetLastPosture?.posture?.role).toBe('stand-in');
    expect(st.bots[0].fleetLastPosture?.posture?.gate).toBeNull();
  });

  it('a newer answered none outranks an older stored covered when the save failed', async () => {
    st.bots = [primaryBot({ fleetLastPosture: { posture: covered, readAt: 1 } })];
    st.failWrite = true;
    st.facts = { success: true, facts: { running: true, nodeId: 'n1' } };
    await tick();
    st.facts = { success: false, error: 'timeout' };
    const v = await tick();
    expect(v.message).not.toContain('co-worker');
    expect(v.standIn?.role).not.toBe('covered');
  });

  it('a stopped primary with no stored posture does not claim it was never read', async () => {
    st.bots = [primaryBot({ status: 'stopped' })];
    const v = await tick();
    expect(v.message).not.toContain('never been read');
    expect(v.message).toContain('since the manager started');
  });

  it('a silent running primary with no stored posture does not claim it was never read', async () => {
    st.bots = [primaryBot()];
    st.facts = { success: false, error: 'timeout' };
    const v = await tick();
    expect(v.message).not.toContain('never been read');
    expect(v.message).toContain('since the manager started');
  });
});
