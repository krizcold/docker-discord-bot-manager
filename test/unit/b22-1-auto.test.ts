import { afterEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ bots: [] as any[], reseeds: [] as string[] }));

vi.mock('../../src/docker/containerManager', () => ({
  getAllBots: () => h.bots,
  getBot: (id: string) => h.bots.find((b) => b.id === id) ?? null,
  isBotBusy: () => null,
  broadcastBotUpdated: () => {},
}));
vi.mock('../../src/instance/fleetReplicationHealth', () => ({ getReplicationHealth: () => null }));
vi.mock('../../src/instance/fleetReplica', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/instance/fleetReplica')>()),
  autoReseedAllowed: () => true,
  reseedStandby: async (instance: any) => { h.reseeds.push(instance.id); return { success: true }; },
}));

import { startFleetReplicaAuto, stopFleetReplicaAuto } from '../../src/instance/fleetReplicaAuto';

const REPLICA = { containerName: 'bot1-fleet-postgres-replica', volume: 'v', slot: 's', primaryHost: 'p', primaryPort: 5433, publicHost: 'h', hostPort: 5440, certHost: 'h', user: 'smdb', db: 'smdb' };
const parked = (startedAt: number) => ({ purpose: 'reseed-standby', phase: 'starting', startedAt, updatedAt: startedAt, parked: true, committed: true, lastError: 'the manager restarted during the seed (phase starting)' });

const tick = async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  try {
    startFleetReplicaAuto();
    await vi.advanceTimersByTimeAsync(60_000);
    for (let i = 0; i < 20; i++) await Promise.resolve();
  } finally {
    stopFleetReplicaAuto();
    vi.useRealTimers();
  }
};

afterEach(() => { h.bots = []; h.reseeds = []; });

describe('R16-37: the automatic re-seed never wipes a whole copy', () => {
  it('skips a parked re-seed whose run refiled the standby whole', async () => {
    h.bots = [{ id: 'b1', displayName: 'Bot 1', fleetDbReplica: { ...REPLICA, seededBy: 1000 }, fleetDbReplicaSeed: parked(1000) }];
    await tick();
    expect(h.reseeds).toEqual([]);
  });

  it('still re-fires a parked re-seed whose copy was cleared', async () => {
    h.bots = [{ id: 'b1', displayName: 'Bot 1', fleetDbReplica: { ...REPLICA, copyCleared: true }, fleetDbReplicaSeed: { ...parked(2000), phase: 'seeding' } }];
    await tick();
    expect(h.reseeds).toEqual(['b1']);
  });
});
