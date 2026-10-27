import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/docker/containerManager', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/docker/containerManager')>()),
  readDeployedCompose: () => 'compose',
}));
vi.mock('../../src/templates/pcsProcessing', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/templates/pcsProcessing')>()),
  fleetAppContainerName: () => 'app-1',
}));
vi.mock('../../src/config/appCapabilities', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/config/appCapabilities')>()),
  findAppCapabilities: () => ({ hooks: { port: 3000, basePath: '/hooks' } }),
}));
vi.mock('../../src/casaos/detector', () => ({ getDeploymentMode: async () => 'docker' }));

import { callAppHook } from '../../src/instance/appHookClient';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('appHookClient: a hook that times out is unknown, not failed', () => {
  it('says the call was sent and no answer came, and flags unknown', async () => {
    vi.stubGlobal('fetch', async () => { throw new DOMException('The operation was aborted due to timeout', 'TimeoutError'); });
    const r = await callAppHook({ id: 'b1', sourceUrl: 'x', updateToken: 'tok', envVars: {} } as any, 'promote', 'POST', {}, 5000);
    expect(r.ok).toBe(false);
    expect(r.unknown).toBe(true);
    expect(r.error).toBe("promote sent, no answer within 5 s; check the app's Fleet view before retrying");
  });

  it('keeps a connection failure as unreachable, without unknown', async () => {
    vi.stubGlobal('fetch', async () => { throw new TypeError('fetch failed'); });
    const r = await callAppHook({ id: 'b1', sourceUrl: 'x', updateToken: 'tok', envVars: {} } as any, 'promote');
    expect(r.unknown).toBeUndefined();
    expect(r.error).toMatch(/^promote unreachable/);
  });

  it('a GET hook that times out says it did not answer, without unknown', async () => {
    vi.stubGlobal('fetch', async () => { throw new DOMException('The operation was aborted due to timeout', 'TimeoutError'); });
    const r = await callAppHook({ id: 'b1', sourceUrl: 'x', updateToken: 'tok', envVars: {} } as any, 'facts', 'GET', undefined, 5000);
    expect(r.unknown).toBeUndefined();
    expect(r.error).toBe('facts did not answer within 5 s');
  });
});
