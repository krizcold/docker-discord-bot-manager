import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm2-reseed-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return { dir, whenClaimed: null as null | string, busy: null as null | Set<string>, seedView: null as null | ((i: any) => any), shutdown: false };
});

vi.mock('child_process', async (importOriginal) => (await import('./nm2-docker')).childProcessMock(await importOriginal()));
vi.mock('../../src/config/appCapabilities', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/config/appCapabilities')>()),
  findAppCapabilities: () => ({ companionDb: { env: { url: 'DATABASE_URL' } }, hooks: { port: 3000, basePath: '/api/managed' } }),
}));
vi.mock('../../src/instance/appHookClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/instance/appHookClient')>()),
  hasAppHooks: () => true,
  capabilityRefusal: () => null,
  getAppFacts: async () => ({
    success: true,
    facts: { copyBlockCurrent: true, copyBlock: { dsn: 'postgresql://replicator:fakepass@primary.example:5432/app', cert: '-----BEGIN CERTIFICATE-----\nZmFrZQ==\n-----END CERTIFICATE-----' } },
  }),
  callAppHook: async () => ({ ok: false, error: 'no bot here' }),
}));
vi.mock('../../src/casaos/detector', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/casaos/detector')>()),
  getDeploymentMode: async () => 'docker',
}));
vi.mock('../../src/webui/server', () => ({ broadcastToClients: () => {} }));
// The main and the copy a Re-seed reads before it starts: the same database, the main at or past the copy.
vi.mock('../../src/instance/fleetJoin', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/instance/fleetJoin')>()),
  mainCertificate: async () => ({ ok: true, pem: (await import('./join-fake')).FIXTURE_PEM }),
  ensureClientImage: async () => null,
  mainProbe: async () => ({ ok: true, facts: { systemId: '7001', timeline: 1, lsn: 100n, inRecovery: false, slot: 'absent' } }),
  readCopyFacts: async () => ({ ok: true, facts: { inRecovery: true, streaming: true, systemId: '7001', timeline: 1, lsn: 50n } }),
}));
vi.mock('../../src/docker/containerManager', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/docker/containerManager')>();
  return {
    ...real,
    isShuttingDown: () => h.shutdown,
    isBotBusy: (id: string) => {
      if (h.whenClaimed && h.busy?.has(id)) {
        if (h.whenClaimed === 'throw') throw new Error('op table unreadable');
        return h.whenClaimed;
      }
      return real.isBotBusy(id);
    },
  };
});
vi.mock('../../src/instance/fleetReplica', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/instance/fleetReplica')>();
  return { ...real, seedView: (i: any) => (h.seedView ? h.seedView(i) : real.seedView(i)) };
});

import * as fs from 'fs';
import * as path from 'path';
import { docker, resetDocker, callsWith } from './nm2-docker';
import { fenceOwners } from './fence-fake';
import { PRIMARY, REPLICA, seedBot, clearRegistry, stored, dumps, startedWithTick, tickOnce } from './nm2-harness';
import { setNow, realNow } from './nm2-harness';
import { joinRecordFor } from './join-fake';

const R_RESEED = "A dump, restore or replication change is running on this instance's database, so the re-seed was refused and nothing was changed; wait for it to finish, then re-seed again";

// One module load for the whole file: the mocked modules keep the first load's state, so a reload would split it.
async function load() {
  const fb = await import('../../src/instance/fleetBackup');
  const fr = await import('../../src/instance/fleetReplica');
  const guards = await import('../../src/instance/fleetBackupGuards');
  const cm = await import('../../src/docker/containerManager');
  h.busy = guards.busy;
  return { fb, fr, guards, cm, bot: () => cm.getBot('a')! };
}

beforeEach(() => {
  resetDocker();
  fenceOwners.clear();
  h.whenClaimed = null;
  h.shutdown = false;
  h.seedView = null;
  docker.overrides.push({ match: a => a.join(' ').includes('pg_is_in_recovery(),'), answer: { ok: true, stdout: 't|streaming|f|1\n' } });
  fs.rmSync(path.join(h.dir, 'backups'), { recursive: true, force: true });
  clearRegistry();
  seedBot({ fleetDbReplica: { ...REPLICA, seededAt: Date.now() - 86400000 }, updateToken: 'tok', fleetJoin: joinRecordFor('postgresql://replicator:fakepass@primary.example:5432/app') });
});
afterAll(() => { fs.rmSync(h.dir, { recursive: true, force: true }); });

describe('NM2 D: a re-seed and a dump exclude each other', () => {
  it('D1 a dump of the instance running: the re-seed is refused with R-RESEED and nothing is changed', async () => {
    let release: () => void = () => {};
    docker.dumpHold = new Promise<void>(r => { release = r; });
    const { fb, fr, bot } = await load();
    const tick = startedWithTick(fb);
    const running = tickOnce(fb, tick);
    await vi.waitFor(() => expect(callsWith('pg_dump').length).toBe(1));
    const res = await fr.reseedStandby(bot());
    release();
    await running;
    expect(res).toEqual({ success: false, error: R_RESEED });
    expect(stored().fleetDbReplicaSeed).toBeUndefined();
    expect(callsWith('pull')).toEqual([]);
  });

  it('D2 a re-seed holding the slot: the tick dumps neither family and raises no copy alert', async () => {
    seedBot({ fleetDb: PRIMARY, fleetDbReplica: { ...REPLICA, seededAt: Date.now() - 86400000 } });
    h.seedView = () => ({ phase: 'seeding', parked: false, purpose: 'reseed-standby', startedAt: Date.now() });
    const { fb, guards } = await load();
    expect(guards.claimFleetBackupBusy('a')).toBe(true);
    const tick = startedWithTick(fb);
    try {
      setNow(Date.now() + 5 * 3_600_000);
      await tickOnce(fb, tick);
    } finally { realNow(); guards.releaseFleetBackupBusy('a'); }
    expect(callsWith('pg_dump')).toEqual([]);
    expect(stored().fleetBackupAlerts?.['copy:dumps']).toBeUndefined();
  });

  it('D3 a re-seed refused before the claim claims nothing', async () => {
    seedBot({ fleetDbReplica: { ...REPLICA, user: undefined } });
    const { fr, guards, bot } = await load();
    const res = await fr.reseedStandby(bot());
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/predates identity stamping/);
    expect(guards.isFleetBackupBusy('a')).toBe(false);
  });

  it('D4 a start that refuses after the claim releases the slot and shows its refusal', async () => {
    const { fr, guards, bot } = await load();
    h.whenClaimed = 'update';
    const res = await fr.reseedStandby(bot());
    expect(res).toEqual({ success: false, error: "Operation 'update' is running on this instance; wait for it to finish" });
    expect(guards.isFleetBackupBusy('a')).toBe(false);
  });

  it('D5 a start that throws releases the slot and rethrows', async () => {
    const { fr, guards, bot } = await load();
    h.whenClaimed = 'throw';
    await expect(fr.reseedStandby(bot())).rejects.toThrow('op table unreadable');
    expect(guards.isFleetBackupBusy('a')).toBe(false);
  });

  it('D6 a re-seed that ends releases the slot', async () => {
    docker.overrides.push({ match: a => a[0] === 'pull', answer: { ok: false, stderr: 'pull refused' } });
    const { fr, guards, bot } = await load();
    const res = await fr.reseedStandby(bot());
    expect(res).toEqual({ success: true, started: true });
    await vi.waitFor(() => expect(guards.isFleetBackupBusy('a')).toBe(false), { timeout: 3000 });
    await vi.waitFor(() => expect(stored().fleetDbReplicaSeed?.parked).toBe(true));
  });

  it('D7 a restart mid re-seed: the slot is gone, the seed parks at boot, and a parked seed does not hold copy dumps', async () => {
    seedBot({ fleetDbReplica: { ...REPLICA, seededAt: Date.now() - 86400000 }, fleetDbReplicaSeed: { purpose: 'reseed-standby', phase: 'seeding', startedAt: Date.now() - 60_000, updatedAt: Date.now() - 60_000 } });
    const { fb, fr, guards } = await load();
    expect(guards.isFleetBackupBusy('a')).toBe(false);
    await fr.parkInterruptedReplicaSeeds();
    expect(stored().fleetDbReplicaSeed.parked).toBe(true);
    const tick = startedWithTick(fb);
    // An hour on: the slot an earlier row's dump attempted is behind.
    setNow(Date.now() + 3_600_000);
    try { await tickOnce(fb, tick); } finally { realNow(); }
    expect(dumps().some(f => f.startsWith('copy-daily-'))).toBe(true);
  });

  it('D7 a cleared copy gets no dump', async () => {
    seedBot({ fleetDbReplica: { ...REPLICA, copyCleared: true }, fleetDbReplicaSeed: { purpose: 'reseed-standby', phase: 'seeding', startedAt: Date.now() - 60_000, updatedAt: Date.now() - 60_000, parked: true } });
    const { fb } = await load();
    const tick = startedWithTick(fb);
    await tickOnce(fb, tick);
    expect(callsWith('pg_dump')).toEqual([]);
  });

  it('D8 a shutdown begun: the claim fails with the shutdown refusal', async () => {
    const { fr, cm, bot } = await load();
    h.shutdown = true;
    const res = await fr.reseedStandby(bot());
    expect(res).toEqual({ success: false, error: cm.SHUTDOWN_REFUSAL });
  });

  it('D9 a restore, decommission or replication change holding the slot refuses the re-seed with R-RESEED', async () => {
    const { fr, guards, bot } = await load();
    expect(guards.claimFleetBackupBusy('a')).toBe(true);
    const res = await fr.reseedStandby(bot());
    guards.releaseFleetBackupBusy('a');
    expect(res).toEqual({ success: false, error: R_RESEED });
    expect(stored().fleetDbReplicaSeed).toBeUndefined();
  });

  // Last: the seed it starts never ends, and the op lock it holds would outlive the row.
  it('D6 a running re-seed holds the slot until it ends', async () => {
    docker.overrides.push({ match: a => a[0] === 'pull', answer: { ok: true, hang: true } });
    const { fr, guards, bot } = await load();
    expect((await fr.reseedStandby(bot())).success).toBe(true);
    expect(guards.isFleetBackupBusy('a')).toBe(true);
    expect(guards.claimFleetBackupBusy('a')).toBe(false);
  });
});
