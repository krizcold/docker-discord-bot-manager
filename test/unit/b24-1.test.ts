import { beforeEach, describe, expect, it, vi } from 'vitest';

const st = vi.hoisted(() => ({
  bots: new Map<string, Record<string, unknown>>(),
  sources: new Map<string, Record<string, unknown>>(),
  onFetch: null as null | ((id: string) => void),
  fetched: [] as string[],
  rebuilt: [] as string[],
  fetchGate: null as null | Promise<void>,
  rebuildGate: null as null | Promise<void>,
}));

vi.mock('../../src/docker/containerManager', () => ({
  registryFault: () => null,
  getAllBots: () => [...st.bots.values()].map(b => ({ ...b })),
  getBot: (id: string) => (st.bots.has(id) ? { ...st.bots.get(id) } : null),
  withoutRecordSecrets: (b: unknown) => b,
  updateInstanceAutoUpdate: (id: string, enabled: boolean) => { st.bots.get(id)!.autoUpdate = enabled; return { ...st.bots.get(id) }; },
  pullAndRebuild: async (id: string) => { st.rebuilt.push(id); if (st.rebuildGate) await st.rebuildGate; return { success: true }; },
}));

vi.mock('../../src/source/sourceManager', () => ({
  getAllSources: () => [...st.sources.values()].map(s => ({ ...s })),
  getSource: (id: string) => (st.sources.has(id) ? { ...st.sources.get(id) } : null),
  readSourceHead: async (id: string) => st.sources.get(id)?.lastCommitHash ?? null,
  fetchSource: async (id: string) => {
    st.fetched.push(id);
    if (st.fetchGate) await st.fetchGate;
    st.onFetch?.(id);
    return { hasUpdates: false, behindBy: 0 };
  },
}));

async function tickOf(start: () => void): Promise<() => void> {
  let tick: () => void = () => {};
  const spy = vi.spyOn(globalThis, 'setInterval').mockImplementation(((fn: () => void) => { tick = fn; return 0; }) as unknown as typeof setInterval);
  start();
  spy.mockRestore();
  return tick;
}
const settle = () => new Promise(r => setTimeout(r, 20));

beforeEach(() => {
  vi.resetModules();
  st.bots.clear(); st.sources.clear(); st.fetched = []; st.rebuilt = []; st.onFetch = null; st.fetchGate = null; st.rebuildGate = null;
  st.bots.set('a', { id: 'a', displayName: 'a', autoUpdate: true, autoUpdateInterval: 60000, sourceType: 'git', sourceId: 's1', lastBuiltCommit: 'old' });
  st.sources.set('s1', { id: 's1', autoUpdate: true, lastChecked: 1, lastCommitHash: 'new' });
  st.sources.set('s2', { id: 's2', autoUpdate: true, lastChecked: 1, lastCommitHash: 'x' });
});

describe('instance auto-update tick re-reads the instance after the fetch', () => {
  it('rebuilds when nothing changed', async () => {
    const iu = await import('../../src/instance/instanceUpdater');
    (await tickOf(iu.startInstanceUpdater))(); await settle(); iu.stopInstanceUpdater();
    expect(st.rebuilt).toEqual(['a']);
  });
  it('skips the rebuild when auto-update was turned off during the fetch', async () => {
    st.onFetch = () => { st.bots.get('a')!.autoUpdate = false; };
    const iu = await import('../../src/instance/instanceUpdater');
    (await tickOf(iu.startInstanceUpdater))(); await settle(); iu.stopInstanceUpdater();
    expect(st.rebuilt).toEqual([]);
  });
  it('skips the rebuild when the source changed during the fetch', async () => {
    st.onFetch = () => { st.bots.get('a')!.sourceId = 's2'; };
    const iu = await import('../../src/instance/instanceUpdater');
    (await tickOf(iu.startInstanceUpdater))(); await settle(); iu.stopInstanceUpdater();
    expect(st.rebuilt).toEqual([]);
  });
  it('skips the rebuild when the built commit changed during the fetch', async () => {
    st.onFetch = () => { st.bots.get('a')!.lastBuiltCommit = 'new2'; };
    const iu = await import('../../src/instance/instanceUpdater');
    (await tickOf(iu.startInstanceUpdater))(); await settle(); iu.stopInstanceUpdater();
    expect(st.rebuilt).toEqual([]);
  });
  it('skips the rebuild when the instance was removed during the fetch', async () => {
    st.onFetch = () => { st.bots.delete('a'); };
    const iu = await import('../../src/instance/instanceUpdater');
    (await tickOf(iu.startInstanceUpdater))(); await settle(); iu.stopInstanceUpdater();
    expect(st.rebuilt).toEqual([]);
  });
  it('a second tick does not start while the first is still running', async () => {
    let open!: () => void; st.fetchGate = new Promise<void>(r => { open = r; });
    st.bots.set('b', { ...st.bots.get('a')!, id: 'b', displayName: 'b' });
    const iu = await import('../../src/instance/instanceUpdater');
    const tick = await tickOf(iu.startInstanceUpdater);
    tick(); await settle(); tick(); await settle();
    expect(st.fetched).toEqual(['s1']);
    open(); await settle(); iu.stopInstanceUpdater();
  });
  it('reports an auto-rebuild in progress', async () => {
    let open!: () => void; st.rebuildGate = new Promise<void>(r => { open = r; });
    const iu = await import('../../src/instance/instanceUpdater');
    (await tickOf(iu.startInstanceUpdater))(); await settle();
    expect(iu.isAutoRebuilding('a')).toBe(true);
    open(); await settle(); iu.stopInstanceUpdater();
    expect(iu.isAutoRebuilding('a')).toBe(false);
  });
});

describe('source update cycle re-reads the source before each fetch', () => {
  it('skips a source whose auto-update was turned off during an earlier fetch', async () => {
    st.onFetch = (id) => { if (id === 's1') st.sources.get('s2')!.autoUpdate = false; };
    const su = await import('../../src/source/sourceUpdater');
    (await tickOf(su.startSourceUpdater))(); await settle(); su.stopSourceUpdater();
    expect(st.fetched).toEqual(['s1']);
  });
  it('skips a source removed during an earlier fetch', async () => {
    st.onFetch = (id) => { if (id === 's1') st.sources.delete('s2'); };
    const su = await import('../../src/source/sourceUpdater');
    (await tickOf(su.startSourceUpdater))(); await settle(); su.stopSourceUpdater();
    expect(st.fetched).toEqual(['s1']);
  });
  it('a second cycle does not start while the first is still running', async () => {
    let open!: () => void; st.fetchGate = new Promise<void>(r => { open = r; });
    const su = await import('../../src/source/sourceUpdater');
    const tick = await tickOf(su.startSourceUpdater);
    tick(); await settle(); tick(); await settle();
    expect(st.fetched).toEqual(['s1']);
    open(); await settle(); su.stopSourceUpdater();
  });
});

describe('PUT /:id/auto-update answer', () => {
  const put = async (rebuilding: boolean, enabled: boolean): Promise<any> => {
    vi.doMock('../../src/instance/instanceUpdater', () => ({ isAutoRebuilding: (id: string) => rebuilding && id === 'a' }));
    vi.doMock('../../src/webui/server', () => ({ broadcastToClients: () => {} }));
    const { createBotRoutes } = await import('../../src/webui/routes/bots');
    const router = createBotRoutes({ clients: new Set() } as any);
    const layer = (router as any).stack.find((l: any) => l.route?.path === '/:id/auto-update' && l.route.methods.put);
    const out = { status: 200, body: undefined as any };
    const res = { status(code: number) { out.status = code; return res; }, json(body: any) { out.body = body; return res; } };
    await layer.route.stack[layer.route.stack.length - 1].handle({ params: { id: 'a' }, query: {}, body: { enabled } }, res);
    vi.doUnmock('../../src/instance/instanceUpdater');
    vi.doUnmock('../../src/webui/server');
    return out;
  };
  it('turning off during a running rebuild says so without promising the result', async () => {
    const r = await put(true, false);
    expect(r.body).toMatchObject({ success: true, autoUpdate: false, rebuildInProgress: true });
    expect(r.body.message).toMatch(/still running/);
    expect(r.body.message).toMatch(/log/);
    expect(r.body.message).not.toMatch(/will finish/);
  });
  it('sends no message when turning on during a rebuild', async () => {
    const r = await put(true, true);
    expect(r.body).toMatchObject({ success: true, rebuildInProgress: true });
    expect(r.body).not.toHaveProperty('message');
  });
  it('sends no message when no rebuild is running', async () => {
    const r = await put(false, false);
    expect(r.body).toMatchObject({ success: true, rebuildInProgress: false });
    expect(r.body).not.toHaveProperty('message');
  });
});
