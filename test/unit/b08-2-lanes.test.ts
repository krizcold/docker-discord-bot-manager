import { beforeEach, describe, expect, it, vi } from 'vitest';

const st = vi.hoisted(() => ({
  bots: new Map<string, Record<string, unknown>>(),
  sources: new Map<string, Record<string, unknown>>(),
  head: 'new' as string | null,
  copyError: undefined as string | undefined,
  rebuilt: [] as string[],
}));

vi.mock('../../src/docker/containerManager', () => ({
  registryFault: () => null,
  getAllBots: () => [...st.bots.values()].map(b => ({ ...b })),
  getBot: (id: string) => (st.bots.has(id) ? { ...st.bots.get(id) } : null),
  pullAndRebuild: async (id: string) => { st.rebuilt.push(id); return { success: true }; },
}));

vi.mock('../../src/source/sourceManager', () => ({
  getAllSources: () => [...st.sources.values()].map(s => ({ ...s })),
  getSource: (id: string) => (st.sources.has(id) ? { ...st.sources.get(id) } : null),
  readSourceHead: async () => st.head,
  fetchSource: async () => (st.copyError ? { hasUpdates: true, behindBy: 1, copyError: st.copyError } : { hasUpdates: false, behindBy: 0 }),
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
  st.bots.clear(); st.sources.clear(); st.rebuilt = []; st.copyError = undefined; st.head = 'new';
  st.bots.set('a', { id: 'a', displayName: 'a', autoUpdate: true, autoUpdateInterval: 60000, sourceType: 'git', sourceId: 's1', lastBuiltCommit: 'old' });
  st.sources.set('s1', { id: 's1', autoUpdate: true, lastChecked: 1, lastCommitHash: 'new' });
});

describe('instance auto-update compares the built commit with the checkout', () => {
  it('skips the rebuild when the checkout is at the built commit, whatever the registry says', async () => {
    st.head = 'old';
    const iu = await import('../../src/instance/instanceUpdater');
    (await tickOf(iu.startInstanceUpdater))(); await settle(); iu.stopInstanceUpdater();
    expect(st.rebuilt).toEqual([]);
  });
  it('rebuilds when the checkout moved past the built commit and the registry did not', async () => {
    st.sources.get('s1')!.lastCommitHash = 'old';
    const iu = await import('../../src/instance/instanceUpdater');
    (await tickOf(iu.startInstanceUpdater))(); await settle(); iu.stopInstanceUpdater();
    expect(st.rebuilt).toEqual(['a']);
  });
});

describe('the source auto-updater on a failed copy', () => {
  it('reports the copy fault once, as a copy fault and not a failed fetch', async () => {
    st.copyError = 'The source moved to bbbbbbb, but the raw copy of the source at bbbbbbb failed: disk full';
    const sent: Array<[string, any]> = [];
    const su = await import('../../src/source/sourceUpdater');
    su.setSourceBroadcast((type, data) => { sent.push([type, data]); });
    (await tickOf(su.startSourceUpdater))(); await settle(); su.stopSourceUpdater();
    expect(sent.filter(([t]) => t === 'source:fetch-failed')).toEqual([]);
    expect(sent.filter(([t]) => t === 'source:copy-failed')).toEqual([['source:copy-failed', { id: 's1', error: st.copyError }]]);
  });
});
