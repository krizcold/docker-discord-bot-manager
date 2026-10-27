import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/templates/pcsProcessing', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/templates/pcsProcessing')>()),
  fleetAppContainerName: () => 'app-1',
}));
vi.mock('../../src/config/appCapabilities', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/config/appCapabilities')>()),
  findAppCapabilities: () => ({ hooks: { port: 3000, basePath: '/hooks' }, companionDb: { env: { url: 'DATABASE_URL' } } }),
}));

vi.mock('../../src/docker/containerManager', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/docker/containerManager')>()),
  readDeployedCompose: () => 'compose',
}));

import { callAppHook } from '../../src/instance/appHookClient';

const instance = { id: 'b1', sourceUrl: 'x', updateToken: 'tok', envVars: {} } as any;
const answer = (body: string, status: number) => vi.stubGlobal('fetch', async () => new Response(body, { status }));

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('NM1 L5: what callAppHook reports for each answer', () => {
  it("an HTTP error carries the app's named error", async () => {
    answer(JSON.stringify({ error: 'the guild is held elsewhere' }), 409);
    expect(await callAppHook(instance, 'confirm-fresh')).toEqual({ ok: false, status: 409, error: 'the guild is held elsewhere' });
  });

  it('an HTTP error with no body names the action and the status', async () => {
    answer('not json', 500);
    expect(await callAppHook(instance, 'confirm-fresh')).toEqual({ ok: false, status: 500, error: 'confirm-fresh returned 500' });
  });

  it("a refusal carries the app's named reason and its body", async () => {
    answer(JSON.stringify({ success: false, error: 'confirm first', needsConfirm: true }), 200);
    expect(await callAppHook(instance, 'confirm-fresh')).toEqual({
      ok: false, status: 200, body: { success: false, error: 'confirm first', needsConfirm: true }, error: 'confirm first',
    });
  });

  it('an answer with no body is a refusal named after the action', async () => {
    answer('not json', 200);
    expect(await callAppHook(instance, 'confirm-fresh')).toEqual({ ok: false, status: 200, body: null, error: 'confirm-fresh refused' });
  });

  it('success: true is ok', async () => {
    answer(JSON.stringify({ success: true }), 200);
    expect(await callAppHook(instance, 'confirm-fresh')).toEqual({ ok: true, status: 200, body: { success: true } });
  });
});
