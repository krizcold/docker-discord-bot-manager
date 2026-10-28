import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm3-l5-g-rebuild-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return {
    dir,
    dumpFail: '',
    removeFail: '',
    applyFail: '',
    sent: [] as string[],
    notify: { dm: 'sent' } as { dm: string; dmError?: string },
    gate: null as Promise<void> | null,
    onApply: null as (() => void) | null,
  };
});

vi.mock('child_process', async (importOriginal) => (await import('./join-fake')).childProcessMock(await importOriginal<typeof import('child_process')>()));
vi.mock('../../src/casaos/detector', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/casaos/detector')>()),
  getDeploymentMode: async () => 'docker',
}));
vi.mock('../../src/instance/backupCheck', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/instance/backupCheck')>()),
  notifyOwner: async (_i: unknown, text: string) => { h.sent.push(text); if (h.gate) await h.gate; return h.notify; },
}));
vi.mock('../../src/instance/fleetBackup', async (importOriginal) => {
  const { docker } = await import('./join-fake');
  return {
    ...(await importOriginal<typeof import('../../src/instance/fleetBackup')>()),
    dumpCopyForRebuild: async () => {
      docker.events.push('dump');
      return h.dumpFail ? { success: false, error: h.dumpFail } : { success: true, file: 'copy-pre-rebuild-2026-10-27T10-00-00-000Z.dump' };
    },
  };
});
vi.mock('../../src/docker/containerManager', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/docker/containerManager')>();
  const { docker } = await import('./join-fake');
  return {
    ...real,
    deployedComposeExists: () => true,
    markPendingApplyIfRunning: async () => undefined,
    applyFleetDbReplicaService: async () => {
      docker.events.push('apply');
      h.onApply?.();
      if (h.applyFail) return { success: false, error: h.applyFail };
      docker.running = 'true';
      return { success: true };
    },
    removeFleetDbReplicaService: async () => {
      docker.events.push('service-out');
      if (h.removeFail) return { success: false, error: h.removeFail };
      docker.running = 'false';
      return { success: true };
    },
  };
});

import * as fs from 'fs';
import * as path from 'path';
import * as containerManager from '../../src/docker/containerManager';
import * as envManager from '../../src/env/manager';
import { certSource } from '../../src/instance/fleetJoin';
import * as fleetReplica from '../../src/instance/fleetReplica';
import { heldMessage, rebuildView, runFleetCopyTick, stoppedMessage } from '../../src/instance/fleetCopyWatch';
import { COPY_PEM, docker, fakeJoinRecord, FIXTURE_FP, FIXTURE_PEM, resetDocker } from './join-fake';

const SMDB = 'https://example.invalid/fake/super-modular-discord-bot';
const REGISTRY = path.join(h.dir, 'instances.json');
const REPLICA = {
  containerName: 'b-fleet-postgres-replica', volume: 'b-fleet-postgres-replica-data', slot: 'fleet_standby_b',
  primaryHost: 'main.invalid', primaryPort: 15432, publicHost: 'copy.invalid', hostPort: 15433, certHost: 'copy.invalid',
  user: 'smdb', db: 'smdb', seededAt: 1,
};
const writeRegistry = (over: Record<string, unknown> = {}) => fs.writeFileSync(REGISTRY, JSON.stringify({ instances: { b: {
  id: 'b', sanitizedName: 'b', displayName: 'B', titleName: 'B', status: 'running', sourceType: 'git', sourceUrl: SMDB,
  envVars: { DATA_BACKEND: 'postgres' }, createdAt: '2026-10-24T00:00:00.000Z', updatedAt: '2026-10-24T00:00:00.000Z',
  fleetJoin: fakeJoinRecord(), fleetDbReplica: REPLICA, ...over,
} } }, null, 2));
const bot = () => containerManager.getBot('b')!;
const settled = async () => {
  for (let i = 0; i < 500; i++) {
    const seed = containerManager.getBot('b')?.fleetDbReplicaSeed;
    if (!seed || seed.parked) return containerManager.getBot('b')!;
    await new Promise(r => setTimeout(r, 10));
  }
  throw new Error('the seed did not settle');
};
const destructive = () => docker.events.filter(e => ['dump', 'service-out', 'wipe', 'basebackup'].includes(e));
const realFetch = certSource.fetch;
let clock = Date.now();

beforeEach(() => {
  resetDocker();
  docker.copy = 'true||7001|1|0/4000000';
  h.dumpFail = ''; h.removeFail = ''; h.applyFail = ''; h.sent = []; h.notify = { dm: 'sent' }; h.gate = null; h.onApply = null;
  certSource.fetch = async () => ({ ok: true, pem: FIXTURE_PEM, fp: FIXTURE_FP });
  fs.rmSync(path.join(h.dir, 'bots'), { recursive: true, force: true });
  fs.mkdirSync(path.join(h.dir, 'bots', 'b', 'env'), { recursive: true });
  writeRegistry();
  clock = Date.now();
});
afterAll(() => {
  certSource.fetch = realFetch;
  fs.rmSync(h.dir, { recursive: true, force: true });
});

describe('NM3 L5 g: the rebuild message', () => {
  it('logs the outcome of the message to the owner', async () => {
    const log = vi.spyOn(console, 'log');
    await runFleetCopyTick(clock);
    await settled();
    expect(log.mock.calls.map(c => String(c[0]))).toContain('[FleetCopy] Message to the owner of B about the rebuild: sent');
    log.mockRestore();
  });

  it('logs a failed message with its reason', async () => {
    h.notify = { dm: 'failed', dmError: 'no DM channel' };
    const log = vi.spyOn(console, 'log');
    await runFleetCopyTick(clock);
    await settled();
    expect(log.mock.calls.map(c => String(c[0]))).toContain('[FleetCopy] Message to the owner of B about the rebuild: failed (no DM channel)');
    log.mockRestore();
  });

  it('a case the registry refuses is sent once and logged', async () => {
    const save = vi.spyOn(containerManager, 'updateInstanceFleetCopyAlert').mockImplementation(() => { throw new Error('EROFS'); });
    const err = vi.spyOn(console, 'error');
    await runFleetCopyTick(clock);
    await settled();
    expect(err.mock.calls.map(c => String(c[0]))).toContain('[FleetCopy] b: the message about the rebuild could not be recorded, so it is sent once now and not tried again (EROFS)');
    expect(h.sent).toHaveLength(1);
    save.mockRestore();
    err.mockRestore();
  });
});

const S = 1_700_000_000_000;
const startingSeed = (over: Record<string, unknown> = {}) => ({
  purpose: 'reseed-standby', phase: 'starting', startedAt: S, updatedAt: S, primaryHost: 'main.invalid', primaryPort: 15432,
  slot: 'fleet_standby_b', committed: true, auto: true, ...over,
});
const setSeedCancel = () => containerManager.updateInstanceFleetDbReplicaSeed('b', { ...bot().fleetDbReplicaSeed!, cancelRequested: true });
const claimVolume = () => {
  const reg = JSON.parse(fs.readFileSync(REGISTRY, 'utf-8'));
  reg.instances.o = { id: 'o', displayName: 'O', sanitizedName: 'o', projectVolumes: [REPLICA.volume] };
  fs.writeFileSync(REGISTRY, JSON.stringify(reg));
};

describe('NM3 L5 g: the automatic run', () => {
  it('a cancel filed while the main is probed takes no dump', async () => {
    certSource.fetch = async () => { setSeedCancel(); return { ok: true, pem: FIXTURE_PEM, fp: FIXTURE_FP }; };
    expect(fleetReplica.startAutoRebuild(bot(), 'absent', async () => true)).toEqual({ started: true });
    await settled();
    expect(destructive()).toEqual([]);
  });

  it('a volume another instance claims while the main is probed stops the run before the dump', async () => {
    certSource.fetch = async () => { claimVolume(); return { ok: true, pem: FIXTURE_PEM, fp: FIXTURE_FP }; };
    fleetReplica.startAutoRebuild(bot(), 'absent', async () => true);
    const after = await settled();
    expect(after.fleetDbReplicaSeed?.lastError).toBe(`the seed stopped before clearing the replica volume ${REPLICA.volume}: instance O (o) uses it`);
    expect(destructive()).toEqual([]);
  });

  it('a wipe that fails on a copy still on record leaves its slot', async () => {
    docker.wipeFail = 'rm: busy';
    fleetReplica.startAutoRebuild(bot(), 'absent', async () => true);
    await settled();
    expect(docker.events).toContain('wipe');
    expect(docker.events).not.toContain('drop-slot');
  });

  it('a failed dump does not start the copy again', async () => {
    h.dumpFail = 'disk full';
    fleetReplica.startAutoRebuild(bot(), 'absent', async () => true);
    await settled();
    expect(docker.events).not.toContain('apply');
  });

  it('a base backup that fails after the wipe does not start the empty copy', async () => {
    docker.basebackupFail = 'pg_basebackup: error: connection lost';
    fleetReplica.startAutoRebuild(bot(), 'absent', async () => true);
    const after = await settled();
    expect(after.fleetDbReplicaSeed?.committed).toBe(true);
    expect(docker.events).not.toContain('apply');
  });

  it('a start that throws after a failed stop is named in the error', async () => {
    h.removeFail = 'compose rewrite refused';
    h.onApply = () => { throw new Error('daemon gone'); };
    fleetReplica.startAutoRebuild(bot(), 'absent', async () => true);
    const after = await settled();
    expect(after.fleetDbReplicaSeed?.lastError).toBe('could not stop the copy: compose rewrite refused; starting the copy again also failed (daemon gone), so press Build on the card, then Apply (or Start if the instance is stopped)');
  });

  it('a cancel before the wipe clears the seed and holds rebuilding', async () => {
    fleetReplica.startAutoRebuild(bot(), 'absent', async () => { setSeedCancel(); return true; });
    const after = await settled();
    expect(after.fleetDbReplicaSeed).toBeUndefined();
    expect(after.fleetDbReplica?.autoRebuildHeldAt).toEqual(expect.any(String));
    expect(docker.events).not.toContain('wipe');
  });

  it('a cancel after the wipe parks the seed and says the copy is gone', async () => {
    h.applyFail = 'daemon down';
    h.onApply = () => { setSeedCancel(); };
    fleetReplica.startAutoRebuild(bot(), 'absent', async () => true);
    const after = await settled();
    expect(after.fleetDbReplicaSeed).toMatchObject({ parked: true, cancelled: true, lastError: 'cancelled after the old copy was cleared, so this standby holds no usable copy until it is re-seeded or removed' });
  });

  it('a refused dump time stops the run and keeps the dump on the seed', async () => {
    const save = vi.spyOn(containerManager, 'updateInstanceFleetDbReplicaAndSeed').mockImplementation(() => { throw new Error('EROFS'); });
    fleetReplica.startAutoRebuild(bot(), 'absent', async () => true);
    const after = await settled();
    save.mockRestore();
    expect(after.fleetDbReplicaSeed).toMatchObject({ parked: true, safetyDump: 'copy-pre-rebuild-2026-10-27T10-00-00-000Z.dump', lastError: 'the time of the safety dump could not be recorded (EROFS), so nothing was deleted; the dump is kept as copy-pre-rebuild-2026-10-27T10-00-00-000Z.dump' });
    expect(docker.events).not.toContain('wipe');
  });

  it('keeps the last three dump times', async () => {
    writeRegistry({ fleetDbReplica: { ...REPLICA, rebuildDumps: [1, 2, 3] } });
    docker.slotFail = 'ERROR:  no slots';
    fleetReplica.startAutoRebuild(bot(), 'absent', async () => true);
    const after = await settled();
    expect(after.fleetDbReplica?.rebuildDumps).toEqual([2, 3, expect.any(Number)]);
  });

  it('an operator re-seed records its dump on the seed', async () => {
    docker.slotFail = 'ERROR:  no slots';
    expect(await fleetReplica.reseedStandby(bot(), { confirm: true })).toMatchObject({ success: true });
    const after = await settled();
    expect(after.fleetDbReplicaSeed).toMatchObject({ parked: true, safetyDump: 'copy-pre-rebuild-2026-10-27T10-00-00-000Z.dump' });
  });
});

describe('NM3 L5 g: the rebuild note on the panel', () => {
  it('a stored case from another run is not read as this one', async () => {
    fleetReplica.startAutoRebuild(bot(), 'absent', async () => true);
    await settled();
    const rebuilt = bot().fleetCopyAlerts!.rebuilt!;
    containerManager.updateInstanceFleetCopyAlert('b', 'rebuilt', { ...rebuilt, since: 1, dm: 'failed', dmError: 'zz' });
    const s = await fleetReplica.getFleetReplicaStatus(bot());
    expect(s.seedNote).toMatch(/ The owner was sent a Discord message\.$/);
    expect(s.rebuiltShown).toBeUndefined();
  });

  it('a stored case not sent yet adds no outcome', async () => {
    fleetReplica.startAutoRebuild(bot(), 'absent', async () => true);
    await settled();
    const rebuilt = bot().fleetCopyAlerts!.rebuilt!;
    containerManager.updateInstanceFleetCopyAlert('b', 'rebuilt', { ...rebuilt, dm: 'pending' });
    const s = await fleetReplica.getFleetReplicaStatus(bot());
    expect(s.seedNote).toMatch(/\(copy-pre-rebuild-2026-10-27T10-00-00-000Z\.dump\)\.$/);
    expect(s.rebuiltShown).toBe(true);
  });

  it('a run whose case was refused still shows its note', async () => {
    const save = vi.spyOn(containerManager, 'updateInstanceFleetCopyAlert').mockImplementation(() => { throw new Error('EROFS'); });
    fleetReplica.startAutoRebuild(bot(), 'absent', async () => true);
    await settled();
    save.mockRestore();
    const s = await fleetReplica.getFleetReplicaStatus(bot());
    expect(s.seedNote).toMatch(/^The copy was rebuilt from the main on .* The owner was sent a Discord message\.$/);
  });
});

describe('NM3 L5 g: the boot settle of a built copy', () => {
  it('stores the message of a run without a cause', async () => {
    writeRegistry({ fleetDbReplica: { ...REPLICA, seededBy: S }, fleetDbReplicaSeed: startingSeed() });
    await fleetReplica.parkInterruptedReplicaSeeds();
    expect(bot().fleetCopyAlerts?.rebuilt?.text).toMatch(/^The live database copy on copy\.invalid was rebuilt from the main on \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC\.$/);
    expect(bot().fleetDbReplicaSeed).toBeUndefined();
  });

  it('leaves a case the same run already stored', async () => {
    writeRegistry({ fleetDbReplica: { ...REPLICA, seededBy: S }, fleetDbReplicaSeed: startingSeed(), fleetCopyAlerts: { rebuilt: { kind: 'rebuilt', text: 'OLD', since: S, dm: 'sent', dmAt: 5 } } });
    await fleetReplica.parkInterruptedReplicaSeeds();
    expect(bot().fleetCopyAlerts?.rebuilt).toMatchObject({ text: 'OLD', dm: 'sent' });
  });

  it('stores the case beside another message', async () => {
    writeRegistry({ fleetDbReplica: { ...REPLICA, seededBy: S }, fleetDbReplicaSeed: startingSeed(), fleetCopyAlerts: { held: { kind: 'held', text: 'H', since: 1, dm: 'sent', dmAt: 5 } } });
    await fleetReplica.parkInterruptedReplicaSeeds();
    expect(bot().fleetCopyAlerts?.rebuilt?.since).toBe(S);
  });

  it('logs a refused case as not sent', async () => {
    writeRegistry({ fleetDbReplica: { ...REPLICA, seededBy: S }, fleetDbReplicaSeed: startingSeed() });
    const save = vi.spyOn(containerManager, 'updateInstanceFleetCopyAlert').mockImplementation(() => { throw new Error('EROFS'); });
    const err = vi.spyOn(console, 'error');
    await fleetReplica.parkInterruptedReplicaSeeds();
    expect(err.mock.calls.map(c => String(c[0]))).toContain('[FleetCopy] b: the message about the rebuild could not be recorded, so it is not sent (EROFS)');
    save.mockRestore();
    err.mockRestore();
  });

  it('a cancelled operator run writes no hold', async () => {
    writeRegistry({ fleetDbReplicaSeed: startingSeed({ auto: undefined, phase: 'seeding', cancelRequested: true }) });
    await fleetReplica.parkInterruptedReplicaSeeds();
    expect(bot().fleetDbReplica?.autoRebuildHeldAt).toBeUndefined();
    expect(bot().fleetDbReplicaSeed?.cancelled).toBe(true);
  });
});

describe('NM3 L5 g: sendRebuiltAlert', () => {
  const caseAt = (since: number) => ({ kind: 'rebuilt', text: 'T', since, dm: 'pending' });
  let release: () => void = () => {};
  const gate = () => { h.gate = new Promise<void>(r => { release = r; }); };

  it('two checks at once send one message', async () => {
    writeRegistry({ fleetCopyAlerts: { rebuilt: caseAt(1) } });
    gate();
    const a = fleetReplica.sendRebuiltAlert('b', clock);
    const b = fleetReplica.sendRebuiltAlert('b', clock);
    release();
    await Promise.all([a, b]);
    expect(h.sent).toEqual(['T']);
  });

  it('a case replaced during the send is left as it is', async () => {
    writeRegistry({ fleetCopyAlerts: { rebuilt: caseAt(1) } });
    gate();
    const a = fleetReplica.sendRebuiltAlert('b', clock);
    await new Promise(r => setTimeout(r, 0));
    containerManager.updateInstanceFleetCopyAlert('b', 'rebuilt', { kind: 'rebuilt', text: 'N', since: 2, dm: 'pending' } as any);
    release();
    expect(await a).toMatchObject({ since: 1, dm: 'sent' });
    expect(bot().fleetCopyAlerts?.rebuilt).toMatchObject({ text: 'N', since: 2, dm: 'pending' });
  });

  it('a case removed during the send answers the outcome', async () => {
    writeRegistry({ fleetCopyAlerts: { rebuilt: caseAt(1) } });
    gate();
    const a = fleetReplica.sendRebuiltAlert('b', clock);
    await new Promise(r => setTimeout(r, 0));
    writeRegistry({ fleetCopyAlerts: { held: { kind: 'held', text: 'H', since: 1, dm: 'sent', dmAt: 5 } } });
    release();
    expect(await a).toMatchObject({ since: 1, dm: 'sent' });
  });
});

describe('NM3 L5 g: more of the automatic run', () => {
  it('a cancel filed while the main is checked for recovery takes no dump', async () => {
    Object.defineProperty(docker, 'seedProbe', { configurable: true, enumerable: true, get: () => { setSeedCancel(); return 'f'; }, set: () => {} });
    try {
      fleetReplica.startAutoRebuild(bot(), 'absent', async () => true);
      await settled();
      expect(docker.events).toContain('seed-probe');
      expect(destructive()).toEqual([]);
    } finally {
      Object.defineProperty(docker, 'seedProbe', { configurable: true, enumerable: true, writable: true, value: 'f' });
    }
  });

  it('a run whose case the same run already stored sends from that case', async () => {
    const T = Date.now();
    const now = vi.spyOn(Date, 'now').mockReturnValue(T);
    try {
      writeRegistry({ fleetCopyAlerts: { rebuilt: { kind: 'rebuilt', text: 'OLD', since: T, dm: 'sent', dmAt: T } } });
      fleetReplica.startAutoRebuild(bot(), 'absent', async () => true);
      await settled();
      await new Promise(r => setTimeout(r, 20));
    } finally {
      now.mockRestore();
    }
    expect(h.sent).toEqual([]);
  });

  it('joins the rebuild line and the run notes with a space', async () => {
    docker.registerFail = 'ERROR:  denied';
    fleetReplica.startAutoRebuild(bot(), 'absent', async () => true);
    await settled();
    const s = await fleetReplica.getFleetReplicaStatus(bot());
    expect(s.seedNote).toMatch(/ The owner was sent a Discord message\. The copy runs, but its address could not be added to the main's list \(ERROR: {2}denied\); the manager tries again every hour\.$/);
  });
});
