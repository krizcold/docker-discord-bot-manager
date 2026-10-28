import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm3-l5-h-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return {
    dir,
    dumpPrefix: [] as string[],
    stayRunning: false,
    onDump: null as (() => void) | null,
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
  notifyOwner: async () => ({ dm: 'sent' }),
}));
vi.mock('../../src/instance/fleetBackup', async (importOriginal) => {
  const { docker } = await import('./join-fake');
  return {
    ...(await importOriginal<typeof import('../../src/instance/fleetBackup')>()),
    dumpCopyForRebuild: async (_i: unknown, prefix: string) => {
      docker.events.push('dump');
      h.dumpPrefix.push(prefix);
      h.onDump?.();
      return { success: true, file: 'copy-pre-rebuild-x.dump' };
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
      docker.running = 'true';
      return { success: true };
    },
    removeFleetDbReplicaService: async () => {
      docker.events.push('service-out');
      if (!h.stayRunning) docker.running = 'false';
      return { success: true };
    },
  };
});

import * as fs from 'fs';
import * as path from 'path';
import * as containerManager from '../../src/docker/containerManager';
import { decodeJoinCode } from '../../src/config/joinCode';
import * as envManager from '../../src/env/manager';
import * as fleetBackupGuards from '../../src/instance/fleetBackupGuards';
import { certSource } from '../../src/instance/fleetJoin';
import * as fleetReplica from '../../src/instance/fleetReplica';
import { codeFor, docker, fakeJoinRecord, FIXTURE_FP, FIXTURE_PEM, resetDocker } from './join-fake';

const SMDB = 'https://example.invalid/fake/super-modular-discord-bot';
const REGISTRY = path.join(h.dir, 'instances.json');
const REPLICA = {
  containerName: 'b-fleet-postgres-replica', volume: 'b-fleet-postgres-replica-data', slot: 'fleet_standby_b',
  primaryHost: 'main.invalid', primaryPort: 15432, publicHost: 'copy.invalid', hostPort: 15433, certHost: 'copy.invalid',
  user: 'smdb', db: 'smdb', seededAt: 1,
};
const SEED = { purpose: 'reseed-standby', phase: 'seeding', startedAt: 5, updatedAt: 5, primaryHost: 'main.invalid', primaryPort: 15432, slot: 'fleet_standby_b' };
const writeRegistry = (over: Record<string, unknown> = {}) => fs.writeFileSync(REGISTRY, JSON.stringify({ instances: { b: {
  id: 'b', sanitizedName: 'b', displayName: 'B', titleName: 'B', status: 'running', sourceType: 'git', sourceUrl: SMDB,
  envVars: { DATA_BACKEND: 'postgres' }, createdAt: '2026-10-24T00:00:00.000Z', updatedAt: '2026-10-24T00:00:00.000Z',
  fleetJoin: fakeJoinRecord(), fleetDbReplica: REPLICA, ...over,
} } }, null, 2));
const editRegistry = (edit: (b: any) => void) => {
  const reg = JSON.parse(fs.readFileSync(REGISTRY, 'utf-8'));
  edit(reg.instances.b);
  fs.writeFileSync(REGISTRY, JSON.stringify(reg, null, 2));
};
const bot = () => containerManager.getBot('b')!;
const settled = async () => {
  for (let i = 0; i < 500; i++) {
    const seed = containerManager.getBot('b')?.fleetDbReplicaSeed;
    if (!seed || seed.parked) return containerManager.getBot('b')!;
    await new Promise(r => setTimeout(r, 10));
  }
  throw new Error('the seed did not settle');
};
const idle = async () => {
  for (let i = 0; i < 500 && containerManager.isBotBusy('b'); i++) await new Promise(r => setTimeout(r, 10));
};
const destructive = () => docker.events.filter(e => ['dump', 'service-out', 'wipe', 'basebackup'].includes(e));
const claimFree = (): boolean => {
  const free = fleetBackupGuards.claimFleetBackupBusy('b');
  if (free) fleetBackupGuards.releaseFleetBackupBusy('b');
  return free;
};
const fixtureCert = async () => ({ ok: true as const, pem: FIXTURE_PEM, fp: FIXTURE_FP });
const realFetch = certSource.fetch;
const realSeedWrite = containerManager.updateInstanceFleetDbReplicaSeed;

beforeEach(() => {
  resetDocker();
  docker.copy = 'true||7001|1|0/4000000';
  h.dumpPrefix = []; h.stayRunning = false; h.onDump = null; h.onApply = null;
  certSource.fetch = fixtureCert;
  fs.rmSync(path.join(h.dir, 'bots'), { recursive: true, force: true });
  fs.mkdirSync(path.join(h.dir, 'bots', 'b', 'env'), { recursive: true });
  writeRegistry();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await idle();
});
afterAll(() => {
  certSource.fetch = realFetch;
  fs.rmSync(h.dir, { recursive: true, force: true });
});

describe('startAutoRebuild refusals', () => {
  it('a bot with no copy on record', () => {
    writeRegistry({ fleetDbReplica: undefined });
    expect(fleetReplica.startAutoRebuild(bot(), 'absent', async () => true)).toEqual({ started: false, reason: 'no copy on record' });
  });

  it('a join code that cannot be read', () => {
    writeRegistry({ fleetJoin: fakeJoinRecord({ code: '' }) });
    expect(fleetReplica.startAutoRebuild(bot(), 'absent', async () => true)).toEqual({ started: false, reason: 'the stored join code cannot be read' });
  });

  it('a seed that is running', () => {
    writeRegistry({ fleetDbReplicaSeed: SEED });
    expect(fleetReplica.startAutoRebuild(bot(), 'absent', async () => true)).toEqual({ started: false, reason: 'a seed is running' });
    expect(bot().fleetDbReplicaSeed?.startedAt).toBe(5);
  });

  it('another operation on the instance', async () => {
    let open: () => void = () => {};
    const held = containerManager.withExternalBotOp('b', 'held-op', () => new Promise<void>(r => { open = r; }));
    try {
      expect(fleetReplica.startAutoRebuild(bot(), 'absent', async () => true)).toEqual({ started: false, reason: "operation 'held-op' is running" });
      expect(bot().fleetDbReplicaSeed).toBeUndefined();
    } finally {
      open();
      await held;
    }
  });

  it('a public host that is not a host name', () => {
    writeRegistry({ fleetDbReplica: { ...REPLICA, publicHost: 'not a host!' } });
    expect(fleetReplica.startAutoRebuild(bot(), 'absent', async () => true)).toEqual({ started: false, reason: 'Public host must be a bare hostname or IPv4 address' });
    expect(bot().fleetDbReplicaSeed).toBeUndefined();
  });

  it('a backup or restore holding the database', () => {
    expect(fleetBackupGuards.claimFleetBackupBusy('b')).toBe(true);
    try {
      expect(fleetReplica.startAutoRebuild(bot(), 'absent', async () => true)).toEqual({ started: false, reason: 'a backup or restore is running on this database' });
      expect(bot().fleetDbReplicaSeed).toBeUndefined();
    } finally {
      fleetBackupGuards.releaseFleetBackupBusy('b');
    }
  });

  it('a start that throws releases the backup slot and names the error', () => {
    const real = containerManager.isBotBusy;
    let calls = 0;
    vi.spyOn(containerManager, 'isBotBusy').mockImplementation((id: string) => {
      calls++;
      if (calls === 2) throw new Error('the lock table broke');
      return real(id);
    });
    expect(fleetReplica.startAutoRebuild(bot(), 'absent', async () => true)).toEqual({ started: false, reason: 'the lock table broke' });
    vi.restoreAllMocks();
    expect(claimFree()).toBe(true);
  });

  it('a seed record that cannot be saved releases the backup slot and names the error', () => {
    vi.spyOn(containerManager, 'updateInstanceFleetDbReplicaSeed').mockImplementation(() => { throw new Error('disk full'); });
    expect(fleetReplica.startAutoRebuild(bot(), 'absent', async () => true)).toEqual({
      started: false, reason: 'The seed did not start: its record could not be saved (disk full); nothing was cleared or stopped',
    });
    vi.restoreAllMocks();
    expect(claimFree()).toBe(true);
    expect(bot().fleetDbReplicaSeed).toBeUndefined();
  });
});

describe('the re-seed preflight', () => {
  it.each([
    ['its container name', (b: any) => { b.fleetDbReplica.containerName = 'other-replica'; }],
    ['its volume', (b: any) => { b.fleetDbReplica.volume = 'other-replica-data'; }],
  ])('a standby record whose %s changed before the preflight deletes nothing', async (_n, edit) => {
    certSource.fetch = async () => { editRegistry(edit); return fixtureCert(); };
    expect(fleetReplica.startAutoRebuild(bot(), 'absent', async () => true)).toEqual({ started: true });
    await idle();
    expect(destructive()).toEqual([]);
    expect(bot().fleetDbReplicaSeed).toBeUndefined();
  });

  it('a changed record whose seed clear fails shows why on the seed', async () => {
    certSource.fetch = async () => { editRegistry(b => { b.fleetDbReplica.volume = 'other-replica-data'; }); return fixtureCert(); };
    vi.spyOn(containerManager, 'updateInstanceFleetDbReplicaSeed').mockImplementation((id: string, v: any) => {
      if (v === null) throw new Error('disk full');
      return realSeedWrite(id, v);
    });
    fleetReplica.startAutoRebuild(bot(), 'absent', async () => true);
    await idle();
    expect(fleetReplica.seedView(bot())?.lastError).toBe('the standby record changed while the re-seed was starting; nothing is left to retry, so Dismiss this; its record could not be written (disk full)');
  });

  it('a verdict that changed is logged, and a failed seed clear shows why on the seed', async () => {
    const log = vi.spyOn(console, 'log');
    vi.spyOn(containerManager, 'updateInstanceFleetDbReplicaSeed').mockImplementation((id: string, v: any) => {
      if (v === null) throw new Error('disk full');
      return realSeedWrite(id, v);
    });
    fleetReplica.startAutoRebuild(bot(), 'absent', async () => false);
    await idle();
    expect(log).toHaveBeenCalledWith('[FleetCopy] B: the copy no longer needs a rebuild');
    expect(fleetReplica.seedView(bot())?.lastError).toBe('the copy no longer needs a rebuild; nothing is left to retry, so Dismiss this; its record could not be written (disk full)');
    expect(destructive()).toEqual([]);
  });

  it('the safety dump is named as a pre-rebuild dump', async () => {
    fleetReplica.startAutoRebuild(bot(), 'absent', async () => true);
    await idle();
    expect(h.dumpPrefix).toEqual(['pre-rebuild-']);
  });

  it('a cancel filed during the safety dump stops before the service goes out', async () => {
    h.onDump = () => editRegistry(b => { b.fleetDbReplicaSeed.cancelRequested = true; });
    fleetReplica.startAutoRebuild(bot(), 'absent', async () => true);
    await idle();
    expect(destructive()).toEqual(['dump']);
  });

  it('a copy container still present after the stop parks the run before the wipe', async () => {
    h.stayRunning = true;
    fleetReplica.startAutoRebuild(bot(), 'absent', async () => true);
    const after = await settled();
    await idle();
    expect(after.fleetDbReplicaSeed?.lastError).toBe('could not stop the copy: its database container is still present after the stop, so its copy cannot be cleared safely');
    expect(destructive()).toEqual(['dump', 'service-out']);
  });
});

describe('the boot settle of an interrupted seed', () => {
  it('a cancelled automatic run whose copy was cleared parks, says so and holds rebuilding', async () => {
    writeRegistry({ fleetDbReplicaSeed: { ...SEED, auto: true, cancelRequested: true, committed: true } });
    await fleetReplica.parkInterruptedReplicaSeeds();
    expect(bot().fleetDbReplicaSeed).toMatchObject({ parked: true, cancelled: true, lastError: 'cancelled after the old copy was cleared, so this standby holds no usable copy until it is re-seeded or removed' });
    expect(bot().fleetDbReplica?.autoRebuildHeldAt).toEqual(expect.any(String));
  });

  it('a cancelled operator run that cleared nothing is cleared with no hold', async () => {
    writeRegistry({ fleetDbReplicaSeed: { ...SEED, cancelRequested: true } });
    await fleetReplica.parkInterruptedReplicaSeeds();
    expect(bot().fleetDbReplicaSeed).toBeUndefined();
    expect(bot().fleetDbReplica?.autoRebuildHeldAt).toBeUndefined();
  });

  it('a new seed filed while the standby was starting again is left on record', async () => {
    writeRegistry({ fleetDbReplica: { ...REPLICA, seededBy: 5 }, fleetDbReplicaSeed: { ...SEED, phase: 'starting' } });
    h.onApply = () => editRegistry(b => { b.fleetDbReplicaSeed = { ...SEED, startedAt: 9 }; });
    await fleetReplica.parkInterruptedReplicaSeeds();
    expect(bot().fleetDbReplicaSeed?.startedAt).toBe(9);
  });
});

describe('Cancel and Dismiss of an automatic rebuild', () => {
  it('a dismiss whose hold cannot be saved is refused and keeps the seed', async () => {
    writeRegistry({ fleetDbReplicaSeed: { ...SEED, phase: 'preparing', parked: true, auto: true, lastError: 'x' } });
    vi.spyOn(containerManager, 'updateInstanceFleetDbReplica').mockImplementation(() => { throw new Error('disk full'); });
    const r = await fleetReplica.cancelReplicaSeed(bot(), { startedAt: 5, parked: true });
    expect(r).toEqual({ success: false, error: 'The stopped seed was not dismissed: automatic rebuilding could not be turned off (disk full)' });
    vi.restoreAllMocks();
    expect(bot().fleetDbReplicaSeed?.startedAt).toBe(5);
  });

  it('a cancel of a running automatic rebuild holds rebuilding', async () => {
    writeRegistry({ fleetDbReplicaSeed: { ...SEED, auto: true } });
    await fleetReplica.cancelReplicaSeed(bot(), { startedAt: 5, parked: false, committed: false, confirm: true });
    expect(bot().fleetDbReplicaSeed?.cancelRequested).toBe(true);
    expect(bot().fleetDbReplica?.autoRebuildHeldAt).toEqual(expect.any(String));
  });

  it('a cancel of a running operator run writes no hold', async () => {
    writeRegistry({ fleetDbReplicaSeed: SEED });
    await fleetReplica.cancelReplicaSeed(bot(), { startedAt: 5, parked: false, committed: false, confirm: true });
    expect(bot().fleetDbReplicaSeed?.cancelRequested).toBe(true);
    expect(bot().fleetDbReplica?.autoRebuildHeldAt).toBeUndefined();
  });
});

describe('Re-seed of a standby', () => {
  it('a copy the manager cleared is re-seeded even when it does not answer', async () => {
    writeRegistry({ fleetDbReplica: { ...REPLICA, copyCleared: true } });
    docker.copy = null;
    expect(await fleetReplica.reseedStandby(bot())).toEqual({ success: true, started: true });
    await idle();
  });

  it('a whole copy that does not answer is refused', async () => {
    docker.copy = null;
    expect(await fleetReplica.reseedStandby(bot())).toEqual({ success: false, error: "The copy on this machine did not answer, so the manager can't confirm it belongs to the database in this join code; nothing was changed. Start the instance and try again." });
  });

  it('a main at the copy\'s own position starts without asking', async () => {
    docker.main.lsn = '0/4000000';
    expect(await fleetReplica.reseedStandby(bot())).toEqual({ success: true, started: true });
    await idle();
  });
});

describe('Remove replica', () => {
  it('a record that cannot be cleared is kept and named', async () => {
    vi.spyOn(containerManager, 'updateInstanceFleetDbReplicaKept').mockImplementation(() => { throw new Error('disk full'); });
    expect(await fleetReplica.removeFleetReplica(bot())).toEqual({
      success: false, error: 'The standby service and container were removed, but its record could not be cleared (disk full); the record is kept, so Remove replica again clears it',
    });
  });
});

const onEvent = (hook: (e: string) => void) => {
  const ev = docker.events;
  ev.push = function (...items: string[]) {
    const n = Array.prototype.push.apply(this, items);
    items.forEach(hook);
    return n;
  };
};

describe('the rebuild message outcome', () => {
  it('an outcome that cannot be saved is logged', async () => {
    writeRegistry({ fleetCopyAlerts: { rebuilt: { kind: 'rebuilt', text: 'rebuilt', since: 5, dm: 'pending' } } });
    vi.spyOn(containerManager, 'updateInstanceFleetCopyAlert').mockImplementation(() => { throw new Error('disk full'); });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    await fleetReplica.sendRebuiltAlert('b');
    expect(err).toHaveBeenCalledWith('[FleetCopy] b: the outcome of the message about the rebuild could not be saved, so a manager restart may send it again (disk full)');
  });
});

describe('the seed run', () => {
  it('a main that cannot be verified over a cleared copy does not say nothing was changed', async () => {
    writeRegistry({ fleetDbReplica: { ...REPLICA, copyCleared: true } });
    certSource.fetch = async () => ({ ok: false, reason: 'timeout' }) as any;
    fleetReplica.startAutoRebuild(bot(), 'absent', async () => true);
    const after = await settled();
    await idle();
    expect(after.fleetDbReplicaSeed?.lastError).toMatch(/^could not verify the primary at main\.invalid:15432: /);
  });

  it('a cancel filed while the slot is prepared deletes nothing', async () => {
    onEvent(e => { if (e === 'slot') editRegistry(b => { b.fleetDbReplicaSeed.cancelRequested = true; }); });
    fleetReplica.startAutoRebuild(bot(), 'absent', async () => true);
    await idle();
    expect(docker.events).not.toContain('wipe');
    expect(bot().fleetDbReplica?.copyCleared).not.toBe(true);
  });

  it('a cancel filed during the wipe stops before the base backup', async () => {
    onEvent(e => { if (e === 'wipe') editRegistry(b => { b.fleetDbReplicaSeed.cancelRequested = true; }); });
    fleetReplica.startAutoRebuild(bot(), 'absent', async () => true);
    await idle();
    expect(docker.events).toContain('wipe');
    expect(docker.events).not.toContain('basebackup');
  });

  it('a wipe that fails parks with its error and the copy marked cleared', async () => {
    docker.wipeFail = 'rm: cannot remove: Device or resource busy\n';
    fleetReplica.startAutoRebuild(bot(), 'absent', async () => true);
    const after = await settled();
    await idle();
    expect(after.fleetDbReplicaSeed?.lastError).toBe('could not clear the replica volume: rm: cannot remove: Device or resource busy');
    expect(after.fleetDbReplica?.copyCleared).toBe(true);
    expect(docker.events).not.toContain('basebackup');
  });

  it('a rebuilt copy keeps the hold and the dump times of the live record', async () => {
    writeRegistry({ fleetDbReplica: { ...REPLICA, autoRebuildHeldAt: '2026-10-20T00:00:00.000Z' } });
    fleetReplica.startAutoRebuild(bot(), 'absent', async () => true);
    await idle();
    const rec = bot().fleetDbReplica!;
    expect(docker.events).toContain('basebackup');
    expect(rec.autoRebuildHeldAt).toBe('2026-10-20T00:00:00.000Z');
    expect(rec.rebuildDumps).toHaveLength(1);
  });

  it('a join code that became unreadable during the run is named in the note', async () => {
    onEvent(e => { if (e === 'basebackup') editRegistry(b => { b.fleetJoin.code = ''; }); });
    fleetReplica.startAutoRebuild(bot(), 'absent', async () => true);
    await idle();
    const note = (await fleetReplica.getFleetReplicaStatus(bot())).seedNote;
    expect(note).toContain("The copy runs, but its address was not added to the main's list: the stored join code cannot be read. Paste the main's join code into Join in the Database window to add it.");
  });

  it('a copy without an address gets no note about the address list', async () => {
    const { publicHost: _h, hostPort: _p, ...noAddress } = REPLICA;
    writeRegistry({ fleetDbReplica: { ...noAddress, certHost: noAddress.containerName } });
    onEvent(e => { if (e === 'basebackup') editRegistry(b => { b.fleetJoin.code = ''; }); });
    fleetReplica.startAutoRebuild(bot(), 'absent', async () => true);
    await idle();
    expect(docker.events).toContain('apply');
    const note = (await fleetReplica.getFleetReplicaStatus(bot())).seedNote ?? '';
    expect(note).not.toContain('its address was not added');
  });

  it('an Apply mark that cannot be saved is logged', async () => {
    vi.spyOn(containerManager, 'markPendingApplyIfRunning').mockImplementation(async () => { throw new Error('disk full'); });
    const warn = vi.spyOn(console, 'warn');
    fleetReplica.startAutoRebuild(bot(), 'absent', async () => true);
    await idle();
    expect(warn).toHaveBeenCalledWith('[FleetReplica] b: the standby runs, but the Apply mark could not be saved: disk full');
  });
});

describe('Finish retire', () => {
  it('pins that still cannot be removed are named on the seed', async () => {
    writeRegistry({ fleetDbReplica: undefined, fleetDbReplicaSeed: { ...SEED, purpose: 'reseed-stale-primary', parked: true, pinsUnretired: ['X'], lastError: 'x' } });
    vi.spyOn(envManager, 'deleteEnvVar').mockImplementation(() => { throw new Error('disk full'); });
    const r = await fleetReplica.finishPinsRetire(bot());
    const keys = r.error!.split(' could still not be removed')[0];
    expect(keys).toContain(', ');
    expect(bot().fleetDbReplicaSeed?.lastError).toBe(`the stale database was retired, but the env pins ${keys} could not be removed (disk full), so this node stays pinned to the retired database and the standby was not seeded; Finish retire removes the pins, then Dismiss this and provision the standby from the join code`);
  });
});

describe('the stale-primary re-seed refusals', () => {
  const STALE = { containerName: 'b-fleet-postgres', user: 'smdb', db: 'smdb', volume: 'b-pgdata', replication: { publicHost: 'self.invalid', hostPort: 5440 } };
  const withOther = (over: Record<string, unknown>) => {
    const reg = JSON.parse(fs.readFileSync(REGISTRY, 'utf-8'));
    reg.instances.c = { id: 'c', sanitizedName: 'c', displayName: 'C', titleName: 'C', status: 'stopped', sourceType: 'git', sourceUrl: SMDB,
      createdAt: '2026-10-24T00:00:00.000Z', updatedAt: '2026-10-24T00:00:00.000Z', ...over };
    fs.writeFileSync(REGISTRY, JSON.stringify(reg, null, 2));
  };
  const code = (dsn: string) => codeFor(dsn);
  beforeEach(() => writeRegistry({ status: 'stopped', fleetDbReplica: undefined, fleetJoin: undefined, fleetDb: STALE }));

  it('a code that is not a join code', () => {
    const why = (decodeJoinCode('nope') as { ok: false; why: string }).why;
    expect(fleetReplica.reseedStalePrimary(bot(), 'nope', 'standby.invalid', 5441)).toEqual({ success: false, error: `This is not a join code: ${why}` });
  });

  it.each([
    ['its primary', { fleetDb: { ...STALE, containerName: 'c-fleet-postgres', replication: { publicHost: 'c.invalid', hostPort: 5441 } } }],
    ['its standby', { fleetDbReplica: { ...REPLICA, containerName: 'c-fleet-postgres-replica', hostPort: 5441 } }],
  ])('a host port another instance uses for %s', (_n, over) => {
    withOther(over);
    expect(fleetReplica.reseedStalePrimary(bot(), code('postgresql://replicator:pw@primary.invalid:5433/smdb'), 'standby.invalid', 5441))
      .toEqual({ success: false, error: 'Host port 5441 is already used by "C" - pick another' });
  });

  it('this instance\'s own port is free, and its own join code is refused', () => {
    expect(fleetReplica.reseedStalePrimary(bot(), code('postgresql://replicator:pw@self.invalid:5440/smdb'), 'standby.invalid', 5440)).toEqual({
      success: false, error: 'That join code is this instance\'s own database, which is the stale one. Paste the join code from the machine that now serves the fleet',
    });
  });
});

describe('Provision', () => {
  it('a standby record of this same instance does not count as a port collision', async () => {
    const stale = { ...bot(), fleetDbReplica: undefined };
    const r = fleetReplica.provisionFleetReplica(stale, 'copy.invalid', 15433);
    expect(r.error ?? '').not.toContain('Host port 15433 is already used');
    await idle();
  });
});
