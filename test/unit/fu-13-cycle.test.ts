import { describe, expect, it, vi } from 'vitest';

vi.mock('../../src/docker/containerManager', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/docker/containerManager')>()),
  startBot: async () => ({ success: true }),
}));
vi.mock('../../src/instance/fleetReplication', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/instance/fleetReplication')>()),
  enableFleetReplication: async () => ({ success: true }),
}));
vi.mock('../../src/instance/appLifecycle', async (importOriginal) => {
  await import('../../src/docker/containerManager');
  return {
    ...(await importOriginal<typeof import('../../src/instance/appLifecycle')>()),
    capabilityRefusal: () => null,
  };
});

const loaded = (load: () => Promise<unknown>): Promise<'loaded' | 'hung'> =>
  Promise.race([load().then(() => 'loaded' as const), new Promise<'hung'>(r => setTimeout(() => r('hung'), 8_000))]);

describe('B14-3c: appLifecycle and fleetReplication mocked over their originals load', () => {
  it('a module that imports appLifecycle before fleetBackup loads without a deadlock', async () => {
    await import('../../src/docker/containerManager');
    expect(await loaded(() => import('../../src/instance/recoveryRescue'))).toBe('loaded');
  }, 15_000);

  it('fleetBackup reads the slot fleetBackupGuards holds', async () => {
    const guards = await import('../../src/instance/fleetBackupGuards');
    const fb = await import('../../src/instance/fleetBackup');
    expect(guards.claimFleetBackupBusy('c1')).toBe(true);
    expect(fb.inFlightLaneBlocker()).toMatch(/running on c1$/);
    guards.releaseFleetBackupBusy('c1');
    expect(fb.inFlightLaneBlocker()).toBeNull();
  });
});
