import { afterAll, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ events: [] as string[] }));
const mark = (name: string) => () => { h.events.push(name); };

vi.mock('child_process', async (importOriginal) => ({ ...(await importOriginal<typeof import('child_process')>()), execSync: () => '' }));
vi.mock('../../src/webui/server', () => ({ startServer: () => ({ wss: { clients: new Set() } }) }));
vi.mock('../../src/docker/dockerClient', () => ({ checkDockerConnection: async () => true }));
vi.mock('../../src/docker/containerManager', () => ({
  syncContainerStates: async () => {}, resetTransientStatuses: () => {}, beginShutdown: () => {}, loadOpRecords: () => {},
}));
vi.mock('../../src/source/sourceManager', () => ({ seedDefaultSources: () => {} }));
vi.mock('../../src/source/sourceUpdater', () => ({ startSourceUpdater: () => {}, stopSourceUpdater: () => {} }));
vi.mock('../../src/instance/instanceUpdater', () => ({ startInstanceUpdater: () => {}, stopInstanceUpdater: () => {} }));
vi.mock('../../src/instance/fleetBackup', () => ({
  startFleetBackupScheduler: () => {}, stopFleetBackupScheduler: () => {}, waitForInFlightLanes: async () => null,
}));
vi.mock('../../src/instance/fleetReplica', () => ({ parkInterruptedReplicaSeeds: async () => {} }));
vi.mock('../../src/instance/fleetCopyWatch', () => ({ startFleetCopyWatch: mark('copy-watch-start'), stopFleetCopyWatch: mark('copy-watch-stop') }));
vi.mock('../../src/instance/maintenance', () => ({ startMaintenanceReconciler: () => {}, stopMaintenanceReconciler: () => {} }));
vi.mock('../../src/docker/stateReconciler', () => ({ startStateReconciler: mark('state-reconciler-start'), stopStateReconciler: () => {} }));
vi.mock('../../src/casaos/detector', () => ({ getDeploymentMode: async () => 'casaos' }));
vi.mock('../../src/config/fileModes', () => ({ warnOnOpenDataRoot: async () => {} }));

const before = {
  SIGTERM: process.listeners('SIGTERM'), SIGINT: process.listeners('SIGINT'),
  uncaughtException: process.listeners('uncaughtException'), unhandledRejection: process.listeners('unhandledRejection'),
};
const added = (name: keyof typeof before) => process.listeners(name as any).filter(l => !(before[name] as unknown[]).includes(l));

afterAll(() => {
  for (const name of Object.keys(before) as Array<keyof typeof before>) {
    for (const l of added(name)) process.removeListener(name as any, l as any);
  }
});

describe('the manager entry point', () => {
  it('starts the copy watch at startup and stops it on SIGTERM', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    await import('../../src/index');
    await vi.waitFor(() => expect(h.events).toContain('state-reconciler-start'));
    expect(h.events).toContain('copy-watch-start');
    expect(h.events).not.toContain('copy-watch-stop');
    const term = added('SIGTERM');
    expect(term).toHaveLength(1);
    (term[0] as () => void)();
    expect(h.events).toContain('copy-watch-stop');
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
  });
});
