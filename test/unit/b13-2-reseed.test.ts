import { describe, expect, it, vi } from 'vitest';

const facts = vi.hoisted(() => ({ backupMaster: false }));

vi.mock('child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('child_process')>();
  const execFile = (_cmd: string, _args: string[], opts: any, cb?: any) => {
    const done = typeof opts === 'function' ? opts : cb;
    done(new Error('no docker in this row'), '', 'no docker');
  };
  return { ...real, execFile, default: { ...real, execFile } };
});
vi.mock('../../src/docker/containerManager', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/docker/containerManager')>()),
  getBot: () => null,
  isBotBusy: () => null,
}));
vi.mock('../../src/instance/appHookClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/instance/appHookClient')>()),
  hasAppHooks: () => true,
}));
vi.mock('../../src/instance/appLifecycle', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/instance/appLifecycle')>()),
  capabilityRefusal: () => null,
  getAppFacts: async () => ({ success: true, facts: { backupMaster: facts.backupMaster, copyBlockCurrent: false } }),
  postureFromRead: () => ({ read: 'ok', posture: { role: 'covered', namesThisNode: false, standInNodeId: 'abcdef0123456789' } }),
}));

import { reseedStandby } from '../../src/instance/fleetReplica';

const instance: any = {
  id: 'b1', sanitizedName: 'bot1', status: 'running',
  fleetDbReplica: { containerName: 'bot1-fleet-replica', user: 'smdb', db: 'smdb' },
};

describe('B13-2 reseedStandby tells a demoted node of an ended failback what it can finish', () => {
  it('a co-worker is told to remove and provision again, or take the backup role first', async () => {
    facts.backupMaster = false;
    const res = await reseedStandby(instance, 'operator');
    expect(res.success).toBe(false);
    expect(res.error).toContain('Remove the replica and provision it again');
    expect(res.error).toContain('BOT_NODE_ROLE=backup-master');
  });
  it('a designated backup is told to demote, then Re-seed now once the block arrives', async () => {
    facts.backupMaster = true;
    const res = await reseedStandby(instance, 'operator');
    expect(res.success).toBe(false);
    expect(res.error).toContain("then Re-seed now once the current primary's copy block reaches this node");
    expect(res.error).not.toContain('Remove the replica');
  });
});
