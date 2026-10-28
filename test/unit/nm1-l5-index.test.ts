import { describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ started: 0, stopped: 0 }));

vi.mock('child_process', () => { const mod = { execSync: () => '' }; return { ...mod, default: mod }; });
vi.mock('../../src/webui/server', () => ({ startServer: () => ({ wss: { clients: new Set() } }) }));
vi.mock('../../src/docker/dockerClient', () => ({ checkDockerConnection: async () => true }));
vi.mock('../../src/docker/containerManager', () => ({
  syncContainerStates: async () => {}, resetTransientStatuses: () => {}, beginShutdown: () => {}, loadOpRecords: () => {},
}));
vi.mock('../../src/source/sourceManager', () => ({ seedDefaultSources: async () => {} }));
vi.mock('../../src/source/sourceUpdater', () => ({ startSourceUpdater: () => {}, stopSourceUpdater: () => {} }));
vi.mock('../../src/instance/instanceUpdater', () => ({ startInstanceUpdater: () => {}, stopInstanceUpdater: () => {} }));
vi.mock('../../src/instance/fleetBackup', () => ({
  startFleetBackupScheduler: () => {}, stopFleetBackupScheduler: () => {}, waitForInFlightLanes: () => new Promise(() => {}),
}));
vi.mock('../../src/instance/fleetReplica', () => ({ parkInterruptedReplicaSeeds: async () => {} }));
vi.mock('../../src/instance/fleetCopyWatch', () => ({ startFleetCopyWatch: () => {}, stopFleetCopyWatch: () => {} }));
vi.mock('../../src/instance/maintenance', () => ({
  startMaintenanceReconciler: () => { h.started++; },
  stopMaintenanceReconciler: () => { h.stopped++; },
}));
vi.mock('../../src/docker/stateReconciler', () => ({ startStateReconciler: () => {}, stopStateReconciler: () => {} }));
vi.mock('../../src/casaos/detector', () => ({ getDeploymentMode: async () => 'casaos' }));
vi.mock('../../src/config/fileModes', () => ({ warnOnOpenDataRoot: async () => {} }));

describe('the manager entry point', () => {
  it('starts the maintenance reconciler at boot and stops it on SIGTERM', async () => {
    const handlers: Record<string, (...a: unknown[]) => void> = {};
    const on = vi.spyOn(process, 'on').mockImplementation(((ev: string, fn: any) => { handlers[ev] = fn; return process; }) as any);
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as any);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await import('../../src/index');
      await vi.waitFor(() => expect(h.started).toBe(1));
      expect(h.stopped).toBe(0);
      handlers.SIGTERM();
      expect(h.stopped).toBe(1);
    } finally {
      on.mockRestore();
      exit.mockRestore();
      log.mockRestore();
    }
  });
});
