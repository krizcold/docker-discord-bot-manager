import { describe, expect, it, vi } from 'vitest';

vi.mock('../../src/docker/containerManager', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/docker/containerManager')>()),
  startBot: async () => ({ success: true }),
}));
vi.mock('../../src/instance/fleetReplication', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/instance/fleetReplication')>()),
  enableFleetReplication: async () => ({ success: true }),
}));
vi.mock('../../src/instance/appHookClient', async (importOriginal) => {
  await import('../../src/docker/containerManager');
  return {
    ...(await importOriginal<typeof import('../../src/instance/appHookClient')>()),
    capabilityRefusal: () => null,
  };
});


describe('B14-3c: appHookClient and fleetReplication mocked over their originals load', () => {
  it('fleetBackup reads the slot fleetBackupGuards holds', async () => {
    const guards = await import('../../src/instance/fleetBackupGuards');
    const fb = await import('../../src/instance/fleetBackup');
    expect(guards.claimFleetBackupBusy('c1')).toBe(true);
    expect(fb.inFlightLaneBlocker()).toMatch(/running on c1$/);
    guards.releaseFleetBackupBusy('c1');
    expect(fb.inFlightLaneBlocker()).toBeNull();
  });
});
