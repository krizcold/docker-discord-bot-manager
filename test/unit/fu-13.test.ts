import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const st = vi.hoisted(() => ({
  bots: [] as any[],
  read: null as any,
  posture: null as any,
  seeds: [] as string[],
  dataDir: '',
  lift: 'lifted' as string,
  lifts: 0,
}));

vi.mock('../../src/webui/server', () => ({ broadcastToClients: () => {} }));
vi.mock('../../src/docker/containerManager', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/docker/containerManager')>()),
  getAllBots: () => st.bots,
  getBot: (id: string) => st.bots.find(b => b.id === id) ?? null,
  updateInstanceFleetFailback: (id: string, run: any) => {
    const b = st.bots.find(x => x.id === id);
    if (b) b.fleetFailback = run;
  },
  updateInstanceFleetFailbackDeclined: (id: string, rec: any) => {
    const b = st.bots.find(x => x.id === id);
    if (b) b.fleetFailbackDeclined = rec;
  },
  updateInstanceFleetLastPosture: () => undefined,
  broadcastBotUpdated: () => undefined,
  stopBot: async () => ({ success: true }),
  startBot: async () => ({ success: true }),
  startFleetDbSidecar: async () => ({ success: true }),
  applyFleetDbReplicaService: async () => ({ success: true }),
}));
vi.mock('../../src/instance/appHookClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/instance/appHookClient')>()),
  hasAppHooks: () => true,
}));
vi.mock('../../src/instance/appLifecycle', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/instance/appLifecycle')>()),
  getAppFacts: async () => st.read,
  postureFromRead: () => st.posture,
}));
vi.mock('../../src/instance/fleetBackup', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/instance/fleetBackup')>()),
  fenceLayers: async () => ({ readOnly: false, hba: false }),
  fenceForConsent: async () => ({ ok: true as const }),
  liftConsentFence: async () => { st.lifts++; return st.lift; },
  failbackFenceLeft: () => false,
  runFleetDump: async () => ({ success: true, file: 'pre-failback-x.dump' }),
}));
vi.mock('../../src/instance/fleetReplica', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/instance/fleetReplica')>()),
  instanceDataDir: async () => st.dataDir,
  getFleetReplicaStatus: async () => ({ live: null }),
  reseedStalePrimary: () => { st.seeds.push('stale-primary'); return { success: true, started: true }; },
  provisionFleetReplica: () => { st.seeds.push('provision'); return { success: true, started: true }; },
  reseedStandby: async () => { st.seeds.push('standby'); return { success: true, started: true }; },
}));

import { cancelFailback, continueFailback, dismissFailback } from '../../src/instance/fleetFailback';

const run = (extra: Record<string, unknown> = {}): any => ({
  mode: 'failback', phase: 'seeding', startedAt: 1, updatedAt: 1, standInNodeId: 'node-abcdef12',
  episode: 3, lineage: null, dump: null, consentAt: 2, block: { host: 'standin.example', port: 5432 },
  serve: { publicHost: 'here.example', hostPort: 6543 }, stoppedByRun: false, parked: true, lastError: 'x',
  fence: null,
  ...extra,
});
const bot = (extra: Record<string, unknown> = {}): any => ({
  id: 'b1', displayName: 'Bot one', status: 'stopped',
  fleetDb: { containerName: 'db-b1', user: 'u', db: 'd', volume: 'vol-b1' },
  ...extra,
});
const live = (): any => st.bots[0];
const blockFile = (): string => path.join(st.dataDir, 'global', 'fleet', 'copy-block.json');
const parkedWith = async (): Promise<string> => {
  await vi.waitFor(() => expect(live().fleetFailback.parked).toBe(true));
  return live().fleetFailback.lastError as string;
};

beforeEach(() => {
  st.bots = [];
  st.read = { success: true, facts: { running: true, initialized: true } };
  st.posture = null;
  st.seeds = [];
  st.lift = 'lifted';
  st.lifts = 0;
  st.dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fu-13-'));
  fs.mkdirSync(path.dirname(blockFile()), { recursive: true });
});

describe('B23-2s: readBlockFile parks the run with the exit its state offers', () => {
  it('an unreadable block file parks the run on Dismiss and re-seeds nothing', async () => {
    st.bots = [bot({ fleetFailback: run() })];
    expect((await continueFailback(live())).success).toBe(true);
    const err = await parkedWith();
    expect(err).toMatch(/^the copy block the bot recorded could not be read \(/);
    expect(err).toContain(blockFile());
    expect(err).toMatch(/; Dismiss this run \(the instance stays stopped\) and re-seed by hand from the block on the stand-in's Database modal$/);
    expect(st.seeds).toEqual([]);
  });

  it('a block without a dsn or a cert parks the run as incomplete', async () => {
    for (const block of [{ dsn: '', cert: 'CERT' }, { dsn: 'postgres://r:p@standin.example:5432/d', cert: '' }, { dsn: 'postgres://r:p@standin.example:5432/d' }]) {
      fs.writeFileSync(blockFile(), JSON.stringify(block));
      st.bots = [bot({ fleetFailback: run() })];
      expect((await continueFailback(live())).success).toBe(true);
      expect(await parkedWith()).toBe('the copy block the bot recorded is incomplete; Dismiss this run (the instance stays stopped) and re-seed by hand from the block on the stand-in\'s Database modal');
    }
    expect(st.seeds).toEqual([]);
  });

  it('a block naming another endpoint says the instance starts again only when the run stopped it', async () => {
    fs.writeFileSync(blockFile(), JSON.stringify({ dsn: 'postgres://r:p@other.example:5432/d', cert: 'CERT' }));
    st.bots = [bot({ fleetFailback: run({ stoppedByRun: true }) })];
    expect((await continueFailback(live())).success).toBe(true);
    const stopped = await parkedWith();
    expect(stopped).toMatch(/^the block the bot holds names other\.example:5432, not the stand-in's copy at standin\.example:5432 this run was decided on; Cancel this run \(nothing here was destroyed: the instance starts again, and Fail back now re-arms the run\), or Dismiss it/);

    st.bots = [bot({ fleetFailback: run({ stoppedByRun: false }) })];
    expect((await continueFailback(live())).success).toBe(true);
    const asWas = await parkedWith();
    expect(asWas).toMatch(/Cancel this run \(nothing here was destroyed: the instance stays stopped, as it was, and Fail back now re-arms the run\)/);
    expect(asWas).not.toMatch(/starts again/);
    expect(st.seeds).toEqual([]);
  });

  it('a block that matches the run re-seeds from it', async () => {
    fs.writeFileSync(blockFile(), JSON.stringify({ dsn: 'postgres://r:p@standin.example:5432/d', cert: 'CERT' }));
    st.bots = [bot({ fleetFailback: run() })];
    expect((await continueFailback(live())).success).toBe(true);
    await vi.waitFor(() => expect(st.seeds).toEqual(['stale-primary']));
  });
});

describe('B23-2s: the drop-back exit keeps a fence it could not lift', () => {
  const copy = { containerName: 'copy-b1', user: 'u', db: 'd', volume: 'copy-vol-b1' };
  const dropBack = () => bot({
    fleetDb: undefined,
    fleetDbReplica: copy,
    fleetFailback: run({ mode: 'drop-back', phase: 'awaiting-block', consentAt: null, block: null, fence: { ok: true, error: null, at: 1, owned: true } }),
  });

  it('a fence that stays on is kept on the run, and the park names its retry', async () => {
    st.posture = { read: 'ok', posture: { role: 'covered' } };
    st.lift = 'locked';
    st.bots = [dropBack()];
    expect((await continueFailback(live())).success).toBe(true);
    const err = await parkedWith();
    expect(err).toMatch(/^the bot no longer reports this copy as an ended stand-in lane; nothing has been changed; the pg_hba lines of its write fence could not be removed/);
    expect(err).toMatch(/\(re-seeding this copy on its Database modal clears it\) \(Continue or Dismiss retries the lift\)$/);
    expect(live().fleetFailback.fence).toMatchObject({ ok: true, owned: true });
    expect(st.lifts).toBe(1);
  });

  it('a lifted fence leaves the run with no fence and no retry text', async () => {
    st.posture = { read: 'ok', posture: { role: 'stand-in', live: true } };
    st.bots = [dropBack()];
    expect((await continueFailback(live())).success).toBe(true);
    expect(await parkedWith()).toBe('the bot no longer reports this copy as an ended stand-in lane; nothing has been changed');
    expect(live().fleetFailback.fence).toBeNull();
    expect(st.lifts).toBe(1);
  });
});

describe('B20-3s: a run fence that could be neither lifted nor stripped names the run\'s remedy', () => {
  it('a failback Cancel names the next restore', async () => {
    st.lift = 'failed';
    st.bots = [bot({ fleetFailback: run({ phase: 'wipe-consent', consentAt: null, fence: { ok: true, error: null, at: 1, owned: true } }) })];
    const r = await cancelFailback(live());
    expect(r.success).toBe(true);
    expect(r.error).toBe('The run is cancelled with nothing destroyed; its write fence could not be lifted or stripped, so the database stays READ-ONLY through a restart (its next restore retries the lift)');
  });

  it('a drop-back Dismiss names the re-seed of the copy', async () => {
    st.lift = 'failed';
    st.bots = [bot({
      fleetDb: undefined,
      fleetDbReplica: { containerName: 'copy-b1', user: 'u', db: 'd', volume: 'copy-vol-b1' },
      fleetFailback: run({ mode: 'drop-back', phase: 'awaiting-block', consentAt: null, block: null, fence: { ok: true, error: null, at: 1, owned: true } }),
    })];
    const r = await dismissFailback(live());
    expect(r.success).toBe(true);
    expect(r.error).toBe('The run is dismissed; its write fence could not be lifted or stripped, so the database stays READ-ONLY through a restart (re-seeding this copy on its Database modal clears it)');
  });
});
