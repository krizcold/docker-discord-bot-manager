import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm3-rebuild-'));
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

describe('O6: the refresh', () => {
  it('C50 to C52: the first tick writes the list from the registry', async () => {
    docker.copy = 'true|streaming|7001|1|0/4000000';
    await runFleetCopyTick(clock);
    const first = envManager.getEnvVars('b').DATA_BACKEND_URL;
    expect(first!.split(',')[0]).toBe('postgresql://smdb:app%2Cpa%25ss@b-fleet-postgres-replica:5432/smdb?sslmode=no-verify');
    expect(first).toContain('@main.invalid:15432/');
  });

  it('F2: reads the address list once an hour, not on every tick', async () => {
    writeRegistry({ fleetJoin: fakeJoinRecord({ addressesReadAt: clock - 3600_000 }) });
    docker.addresses = [{ host: 'other.invalid', port: 15434, slot: 'fleet_standby_x', cert: COPY_PEM, machine: 'other' }];
    docker.copy = 'true|streaming|7001|1|0/4000000';
    await runFleetCopyTick(clock);
    expect(docker.events.filter(e => e === 'address-read')).toHaveLength(1);
    expect(bot().fleetJoin?.addresses).toHaveLength(1);
    expect(envManager.getEnvVars('b').DATA_BACKEND_URL).toContain('@other.invalid:15434/');
    docker.events = [];
    await runFleetCopyTick(clock + 60_000);
    expect(docker.events).not.toContain('address-read');
  });

  it.each([
    ['T-17 a refused login', () => { docker.main.fail = 'psql: error: FATAL:  password authentication failed for user "replicator"'; }, /^The main at main.invalid:15432 refused the join code's login/],
    ['T-15 an unreachable main', () => { certSource.fetch = async () => ({ ok: false, reason: 'timeout' }); }, /^Can't reach the main at main.invalid:15432 \(timeout\)/],
    ['T-16 another certificate', () => { certSource.fetch = async () => ({ ok: true, pem: COPY_PEM, fp: 'f'.repeat(64) }); }, /^The database at main.invalid:15432 shows a certificate with fingerprint ffffffffffffffff/],
    ['T-18 a main in recovery', () => { docker.main.inRecovery = true; }, /^The database at main.invalid:15432 follows another database itself/],
    ['T-32 another system id', () => { docker.main.systemId = '9999'; }, /^The database at main.invalid:15432 is not the one this machine joined \(its system id changed\), so the address list was not updated/],
  ])('C53: %s is recorded and the list kept', async (_n, arrange, error) => {
    const kept = [{ host: 'kept.invalid', port: 1, slot: null, cert: COPY_PEM, machine: 'k' }];
    writeRegistry({ fleetJoin: fakeJoinRecord({ addressesReadAt: clock - 3600_000, addresses: kept }) });
    docker.copy = 'true|streaming|7001|1|0/4000000';
    arrange();
    await runFleetCopyTick(clock);
    expect(bot().fleetJoin?.addressesError).toMatch(error);
    expect(bot().fleetJoin?.addresses).toEqual(kept);
    expect(bot().fleetJoin?.addressesReadAt).toBe(clock - 3600_000);
  });
});

describe('O7: the automatic rebuild', () => {
  it('runs dump, service out, slot, wipe, base backup, start, register, then messages the owner (T-38, T-39, T-40)', async () => {
    await runFleetCopyTick(clock);
    const after = await settled();
    expect(after.fleetDbReplicaSeed).toBeUndefined();
    expect(docker.events.filter(e => ['dump', 'service-out', 'slot', 'wipe', 'basebackup', 'apply', 'register'].includes(e)))
      .toEqual(['dump', 'service-out', 'slot', 'wipe', 'basebackup', 'apply', 'register']);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]).toMatch(/^The live database copy on copy\.invalid was rebuilt from the main on \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC: the main had stopped keeping the changes it was missing\. A backup of the old copy is kept on that machine as copy-pre-rebuild-2026-10-27T10-00-00-000Z\.dump\.$/);
    const note = (await fleetReplica.getFleetReplicaStatus(after)).seedNote!;
    expect(note).toMatch(/^The copy was rebuilt from the main on .* UTC: the main no longer kept its place\. A dump of the old copy is kept with the backups \(copy-pre-rebuild-2026-10-27T10-00-00-000Z\.dump\)\. The owner was sent a Discord message\.$/);
  });

  it.each([
    ['another timeline', () => { docker.main.timeline = 2; }],
    ['a main behind the copy', () => { docker.main.lsn = '0/1000000'; }],
    ['another system id', () => { docker.main.systemId = '9999'; }],
    ['a main in recovery', () => { docker.main.inRecovery = true; }],
    ['the slot kept', () => { docker.main.slot = 'kept'; }],
    ['an operator hold', () => writeRegistry({ fleetDbReplica: { ...REPLICA, autoRebuildHeldAt: '2026-10-20T00:00:00.000Z' } })],
    ['a copy that does not answer', () => { docker.copy = null; }],
    ['a promoted copy', () => { docker.copy = 'false||7001|2|0/9000000'; }],
    ['a main that does not answer', () => { certSource.fetch = async () => ({ ok: false, reason: 'timeout' }); }],
  ])('%s: nothing destructive runs', async (_n, arrange) => {
    arrange();
    await runFleetCopyTick(clock);
    await new Promise(r => setTimeout(r, 50));
    expect(destructive()).toEqual([]);
    expect(bot().fleetDbReplicaSeed).toBeUndefined();
  });

  it('C63: a verdict that changed inside the lock clears the seed with nothing deleted', async () => {
    const r = fleetReplica.startAutoRebuild(bot(), 'absent', async () => false);
    expect(r).toEqual({ started: true });
    const after = await settled();
    expect(after.fleetDbReplicaSeed).toBeUndefined();
    expect(destructive()).toEqual([]);
  });

  it('C64: a failed safety dump parks with nothing deleted (T-35)', async () => {
    h.dumpFail = 'only 10 MB is free';
    await runFleetCopyTick(clock);
    const after = await settled();
    expect(after.fleetDbReplicaSeed).toMatchObject({ parked: true, auto: true, lastError: 'the safety dump of the copy failed, so nothing was deleted: only 10 MB is free' });
    expect(after.fleetDbReplicaSeed?.committed).not.toBe(true);
    expect(destructive()).toEqual(['dump']);
  });

  it('C66: a stop that fails applies the service again (T-36 when that fails too)', async () => {
    h.removeFail = 'compose rewrite refused';
    await runFleetCopyTick(clock);
    let after = await settled();
    expect(after.fleetDbReplicaSeed?.lastError).toBe('could not stop the copy: compose rewrite refused');
    expect(docker.events.filter(e => e === 'apply')).toHaveLength(1);
    fleetReplica.retryHeldSeedRecords();
    await fleetReplica.cancelReplicaSeed(after, { startedAt: after.fleetDbReplicaSeed!.startedAt, parked: true });
    writeRegistry();
    h.applyFail = 'daemon down';
    docker.events = [];
    await runFleetCopyTick(clock + 3600_000);
    after = await settled();
    expect(after.fleetDbReplicaSeed?.lastError).toBe('could not stop the copy: compose rewrite refused; starting the copy again also failed (daemon down), so press Build on the card, then Apply (or Start if the instance is stopped)');
  });

  it('C68: a slot step that fails after the service went out applies it again, with the copy whole', async () => {
    docker.slotFail = 'ERROR:  too many replication slots';
    await runFleetCopyTick(clock);
    const after = await settled();
    expect(after.fleetDbReplicaSeed?.lastError).toBe('could not prepare the replication slot on the primary: ERROR:  too many replication slots');
    expect(after.fleetDbReplicaSeed?.committed).not.toBe(true);
    expect(docker.events.filter(e => ['service-out', 'slot', 'apply'].includes(e))).toEqual(['service-out', 'slot', 'apply']);
    expect(docker.events).not.toContain('wipe');
  });

  it('C72: a refused message is named on the panel (T-41) and the log', async () => {
    h.notify = { dm: 'failed', dmError: 'notify-owner unreachable: fetch failed' };
    await runFleetCopyTick(clock);
    const after = await settled();
    expect((await fleetReplica.getFleetReplicaStatus(after)).seedNote).toMatch(/ The owner could not be messaged: notify-owner unreachable: fetch failed\.$/);
  });

  it('C73: an unanswered message cannot be confirmed (T-42)', async () => {
    h.notify = { dm: 'unknown' };
    await runFleetCopyTick(clock);
    const after = await settled();
    expect((await fleetReplica.getFleetReplicaStatus(after)).seedNote).toMatch(/ Whether the owner was messaged can't be confirmed: the bot took the message but did not answer in time\.$/);
  });

  it('C74: a stopped bot is not messaged (T-41)', async () => {
    writeRegistry({ status: 'stopped' });
    await runFleetCopyTick(clock);
    const after = await settled();
    expect(h.sent).toEqual([]);
    expect((await fleetReplica.getFleetReplicaStatus(after)).seedNote).toMatch(/ The owner could not be messaged: the bot on this machine is not running\.$/);
  });

  it('C69: a cleared copy retried after 30 minutes takes no dump', async () => {
    const parkedAt = clock - 31 * 60_000;
    writeRegistry({
      fleetDbReplica: { ...REPLICA, copyCleared: true },
      fleetDbReplicaSeed: { purpose: 'reseed-standby', phase: 'seeding', startedAt: parkedAt, updatedAt: parkedAt, primaryHost: 'main.invalid', primaryPort: 15432, slot: 'fleet_standby_b', committed: true, parked: true, auto: true, lastError: 'pg_basebackup failed' },
    });
    await runFleetCopyTick(clock);
    const after = await settled();
    expect(after.fleetDbReplicaSeed).toBeUndefined();
    expect(docker.events).not.toContain('dump');
    expect(docker.events).toContain('basebackup');
  });

  it('a parked automatic run is not retried before 30 minutes', async () => {
    const parkedAt = clock - 10 * 60_000;
    writeRegistry({ fleetDbReplicaSeed: { purpose: 'reseed-standby', phase: 'preparing', startedAt: parkedAt, updatedAt: parkedAt, primaryHost: 'main.invalid', primaryPort: 15432, slot: 'fleet_standby_b', parked: true, auto: true, lastError: 'x' } });
    await runFleetCopyTick(clock);
    expect(destructive()).toEqual([]);
    expect(bot().fleetDbReplicaSeed?.startedAt).toBe(parkedAt);
  });

  it('C82: a parked operator run is never retried by the watcher', async () => {
    const parkedAt = clock - 5 * 3600_000;
    writeRegistry({ fleetDbReplicaSeed: { purpose: 'reseed-standby', phase: 'preparing', startedAt: parkedAt, updatedAt: parkedAt, primaryHost: 'main.invalid', primaryPort: 15432, slot: 'fleet_standby_b', parked: true, lastError: 'x' } });
    await runFleetCopyTick(clock);
    expect(destructive()).toEqual([]);
  });
});

describe('O11: a cancel or dismiss turns automatic rebuilding off (C89 to C91)', () => {
  it('C89: a cancel of a running automatic rebuild writes the hold before the sweep', async () => {
    h.dumpFail = '';
    const started = fleetReplica.startAutoRebuild(bot(), 'absent', async () => { await new Promise(r => setTimeout(r, 100)); return true; });
    expect(started.started).toBe(true);
    const seed = bot().fleetDbReplicaSeed!;
    await fleetReplica.cancelReplicaSeed(bot(), { startedAt: seed.startedAt, parked: false, committed: false, confirm: true });
    expect(bot().fleetDbReplica?.autoRebuildHeldAt).toEqual(expect.any(String));
    await settled();
  });

  it('C90: a dismiss of a parked automatic rebuild writes the hold', async () => {
    writeRegistry({ fleetDbReplicaSeed: { purpose: 'reseed-standby', phase: 'preparing', startedAt: 5, updatedAt: 5, primaryHost: 'main.invalid', primaryPort: 15432, slot: 'fleet_standby_b', parked: true, auto: true, lastError: 'x' } });
    const r = await fleetReplica.cancelReplicaSeed(bot(), { startedAt: 5, parked: true });
    expect(r).toMatchObject({ success: true, dismissed: true });
    expect(bot().fleetDbReplica?.autoRebuildHeldAt).toEqual(expect.any(String));
    expect(bot().fleetDbReplicaSeed).toBeUndefined();
  });

  it('C91: a cancel the boot settles holds too', async () => {
    writeRegistry({ fleetDbReplicaSeed: { purpose: 'reseed-standby', phase: 'seeding', startedAt: 5, updatedAt: 5, primaryHost: 'main.invalid', primaryPort: 15432, slot: 'fleet_standby_b', auto: true, cancelRequested: true, committed: true } });
    await fleetReplica.parkInterruptedReplicaSeeds();
    expect(bot().fleetDbReplica?.autoRebuildHeldAt).toEqual(expect.any(String));
  });

  it('a dismiss of an operator run writes no hold', async () => {
    writeRegistry({ fleetDbReplicaSeed: { purpose: 'reseed-standby', phase: 'preparing', startedAt: 5, updatedAt: 5, primaryHost: 'main.invalid', primaryPort: 15432, slot: 'fleet_standby_b', parked: true, lastError: 'x' } });
    await fleetReplica.cancelReplicaSeed(bot(), { startedAt: 5, parked: true });
    expect(bot().fleetDbReplica?.autoRebuildHeldAt).toBeUndefined();
  });
});

describe('the owner is messaged once per case (owner ruling on Q1, 2026-10-27)', () => {
  it('a held copy sends one message, a second check sends none, and the case coming back sends again', async () => {
    docker.main.timeline = 2;
    await runFleetCopyTick(clock);
    const reason = 'the main is on timeline 2 and this copy on timeline 1, so the main changed since this copy was made';
    expect(h.sent).toEqual([heldMessage(bot(), reason)]);
    expect(h.sent[0]).toBe(`The live database copy on copy.invalid needs a rebuild from the main, and it was not rebuilt automatically: ${reason}. Open that machine's manager to press Re-seed.`);
    await runFleetCopyTick(clock + 6 * 60_000);
    expect(h.sent).toHaveLength(1);
    docker.copy = 'true|streaming|7001|2|0/6000000';
    await runFleetCopyTick(clock + 12 * 60_000);
    expect(bot().fleetCopyAlerts).toBeUndefined();
    docker.copy = 'true||7001|1|0/4000000';
    await runFleetCopyTick(clock + 18 * 60_000);
    expect(h.sent).toHaveLength(2);
  });

  it('a check that cannot read the main leaves the case as it was', async () => {
    docker.main.timeline = 2;
    await runFleetCopyTick(clock);
    certSource.fetch = async () => ({ ok: false, reason: 'timeout' });
    await runFleetCopyTick(clock + 6 * 60_000);
    certSource.fetch = async () => ({ ok: true, pem: FIXTURE_PEM, fp: FIXTURE_FP });
    await runFleetCopyTick(clock + 12 * 60_000);
    expect(h.sent).toHaveLength(1);
  });

  it('a send that fails (a stopped bot) is tried again hourly, not on every check, and shows on the panel', async () => {
    docker.main.timeline = 2;
    h.notify = { dm: 'failed', dmError: 'notify-owner unreachable: fetch failed' };
    await runFleetCopyTick(clock);
    expect(rebuildView(bot())).toMatchObject({ kind: 'held', alerts: { held: { dm: 'failed', outcome: 'The owner could not be messaged: notify-owner unreachable: fetch failed.' } } });
    await runFleetCopyTick(clock + 30 * 60_000);
    expect(h.sent).toHaveLength(1);
    h.notify = { dm: 'sent' };
    await runFleetCopyTick(clock + 61 * 60_000);
    expect(h.sent).toHaveLength(2);
    expect(rebuildView(bot())).toMatchObject({ alerts: { held: { dm: 'sent', outcome: 'The owner was sent a Discord message.' } } });
    await runFleetCopyTick(clock + 130 * 60_000);
    expect(h.sent).toHaveLength(2);
  });

  it('an automatic rebuild that stopped after the old copy was deleted sends one message', async () => {
    const parkedAt = clock - 5 * 60_000;
    writeRegistry({
      fleetDbReplica: { ...REPLICA, copyCleared: true },
      fleetDbReplicaSeed: { purpose: 'reseed-standby', phase: 'seeding', startedAt: parkedAt, updatedAt: parkedAt, primaryHost: 'main.invalid', primaryPort: 15432, slot: 'fleet_standby_b', committed: true, parked: true, auto: true, lastError: 'pg_basebackup failed: could not connect', safetyDump: 'copy-pre-rebuild-x.dump' },
    });
    await runFleetCopyTick(clock);
    expect(h.sent).toEqual([stoppedMessage(bot(), 'pg_basebackup failed: could not connect', 'copy-pre-rebuild-x.dump')]);
    expect(h.sent[0]).toBe("The automatic rebuild of the live database copy on copy.invalid stopped after the old copy was deleted: pg_basebackup failed: could not connect. That machine holds no copy of the database until a rebuild finishes; its manager tries again every 30 minutes, and Re-seed in that machine's manager starts one now. A backup of the old copy is kept on that machine as copy-pre-rebuild-x.dump.");
    await runFleetCopyTick(clock + 6 * 60_000);
    expect(h.sent).toHaveLength(1);
    expect(rebuildView(bot())).toMatchObject({ alerts: { stopped: { outcome: 'The owner was sent a Discord message.' } } });
  });
});

const patchRegistry = (over: Record<string, unknown>) => {
  const reg = JSON.parse(fs.readFileSync(REGISTRY, 'utf-8'));
  Object.assign(reg.instances.b, over);
  fs.writeFileSync(REGISTRY, JSON.stringify(reg, null, 2));
};
const clearedSeed = (at: number, over: Record<string, unknown> = {}) => ({
  purpose: 'reseed-standby', phase: 'seeding', startedAt: at, updatedAt: at, primaryHost: 'main.invalid', primaryPort: 15432,
  slot: 'fleet_standby_b', committed: true, parked: true, lastError: 'x', ...over,
});

describe('round 1 fixes', () => {
  it('F1: the watcher leaves the Database URL of a machine whose copy became the main alone', async () => {
    writeRegistry({ fleetDbReplica: undefined, fleetDb: { containerName: 'b-fleet-postgres-replica', user: 'smdb', db: 'smdb', volume: 'b-fleet-postgres-replica-data' } });
    const url = 'postgresql://smdb:pw@b-fleet-postgres-replica:5432/smdb?sslmode=no-verify';
    envManager.setEnvVars('b', { DATA_BACKEND_URL: url });
    await runFleetCopyTick(clock);
    expect(envManager.getEnvVars('b').DATA_BACKEND_URL).toBe(url);
  });

  it('F1: adopting the copy as the main clears the join and the copy messages', () => {
    writeRegistry({ fleetCopyAlerts: { held: { kind: 'held', text: 'x', since: 1, dm: 'sent', dmAt: 1 } } });
    expect(containerManager.adoptFleetDbReplicaAsPrimary('b')).toEqual({ success: true });
    expect(bot().fleetDb).toBeDefined();
    expect(bot().fleetJoin).toBeUndefined();
    expect(bot().fleetCopyAlerts).toBeUndefined();
  });

  it('F2: a cleared copy whose slot is still on the main is rebuilt after 30 minutes', async () => {
    docker.main.slot = 'kept';
    const parkedAt = clock - 31 * 60_000;
    writeRegistry({ fleetDbReplica: { ...REPLICA, copyCleared: true }, fleetDbReplicaSeed: clearedSeed(parkedAt, { auto: true, lastError: 'could not clear the replica volume: busy' }) });
    await runFleetCopyTick(clock);
    const after = await settled();
    expect(docker.events).toContain('basebackup');
    expect(after.fleetDbReplicaSeed).toBeUndefined();
  });

  it('F3: a third safety dump within 24 hours holds the copy, and the owner gets one message', async () => {
    docker.slotFail = 'ERROR:  all replication slots are in use';
    for (const minutes of [0, 31, 62, 93]) {
      await runFleetCopyTick(clock + minutes * 60_000);
      await settled();
    }
    expect(docker.events.filter(e => e === 'dump')).toHaveLength(3);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]).toMatch(/not rebuilt automatically: 3 automatic rebuilds took a safety dump of this copy since \d{4}-\d{2}-\d{2}, and no more start until a Re-seed in its manager; the last one stopped: could not prepare the replication slot on the primary: ERROR: {2}all replication slots are in use\. Open that machine's manager to press Re-seed\.$/);
    expect(h.sent[0]).not.toMatch(/lost its place|WAL/);
    expect(rebuildView(bot())).toMatchObject({ kind: 'held' });
  });

  it('F4: the list is written from the instance as it is at the write, not as the tick began', async () => {
    const reg = JSON.parse(fs.readFileSync(REGISTRY, 'utf-8'));
    const b = { ...reg.instances.b };
    delete b.fleetDbReplica;
    fs.writeFileSync(REGISTRY, JSON.stringify({ instances: {
      a: { ...b, id: 'a', sanitizedName: 'a', displayName: 'A', fleetJoin: fakeJoinRecord({ addressesReadAt: clock - 3600_000 }) },
      b,
    } }, null, 2));
    fs.mkdirSync(path.join(h.dir, 'bots', 'a', 'env'), { recursive: true });
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    let entered!: () => void;
    const inFetch = new Promise<void>(r => { entered = r; });
    certSource.fetch = async () => { entered(); await gate; return { ok: true, pem: FIXTURE_PEM, fp: FIXTURE_FP }; };
    const tick = runFleetCopyTick(clock);
    await inFetch;
    certSource.fetch = async () => ({ ok: true, pem: FIXTURE_PEM, fp: FIXTURE_FP });
    containerManager.updateInstanceFleetJoin('b', fakeJoinRecord({}, { host: 'main2.invalid' }) as any);
    release();
    await tick;
    expect(envManager.getEnvVars('b').DATA_BACKEND_URL).toContain('@main2.invalid:15432/');
  });

  it('C55: a code that changes during the hourly read is not overwritten', async () => {
    const kept = [{ host: 'kept.invalid', port: 1, slot: null, cert: COPY_PEM, machine: 'k' }];
    writeRegistry({ fleetJoin: fakeJoinRecord({ addressesReadAt: clock - 3600_000 }) });
    docker.addresses = [{ host: 'other.invalid', port: 15434, slot: 'fleet_standby_x', cert: COPY_PEM, machine: 'other' }];
    docker.copy = 'true|streaming|7001|1|0/4000000';
    let swapped = false;
    certSource.fetch = async () => {
      if (!swapped) {
        swapped = true;
        containerManager.updateInstanceFleetJoin('b', fakeJoinRecord({ addresses: kept, addressesReadAt: 5 }, { host: 'main2.invalid' }) as any);
      }
      return { ok: true, pem: FIXTURE_PEM, fp: FIXTURE_FP };
    };
    await runFleetCopyTick(clock);
    expect(bot().fleetJoin).toMatchObject({ host: 'main2.invalid', addresses: kept, addressesReadAt: 5 });
  });

  it('F6: a rebuild message a stopped bot could not get is sent hourly until the bot runs (C72)', async () => {
    writeRegistry({ status: 'stopped' });
    await runFleetCopyTick(clock);
    await settled();
    expect(h.sent).toEqual([]);
    patchRegistry({ status: 'running' });
    docker.copy = 'true|streaming|7001|1|0/4000000';
    await runFleetCopyTick(clock + 30 * 60_000);
    expect(h.sent).toEqual([]);
    await runFleetCopyTick(clock + 61 * 60_000);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]).toMatch(/^The live database copy on copy\.invalid was rebuilt from the main on \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC: the main had stopped keeping the changes it was missing\./);
    await runFleetCopyTick(clock + 130 * 60_000);
    expect(h.sent).toHaveLength(1);
  });

  it('F6: a rebuild message the manager restarted before sending is sent at the next check (C73)', async () => {
    docker.copy = 'true|streaming|7001|1|0/4000000';
    const text = 'The live database copy on copy.invalid was rebuilt from the main on 2026-10-27 10:00 UTC: the main had stopped keeping the changes it was missing.';
    writeRegistry({ fleetCopyAlerts: { rebuilt: { kind: 'rebuilt', text, since: 5, dm: 'pending' } } });
    await runFleetCopyTick(clock);
    expect(h.sent).toEqual([text]);
    expect(rebuildView(bot())).toMatchObject({ alerts: { rebuilt: { dm: 'sent' } } });
  });

  it('F6: a newer rebuild replaces the stored message, and no verdict ends it', async () => {
    writeRegistry({ fleetCopyAlerts: { rebuilt: { kind: 'rebuilt', text: 'old', since: 5, dm: 'sent', dmAt: 5 } } });
    await runFleetCopyTick(clock);
    await settled();
    expect(h.sent).toHaveLength(1);
    expect(bot().fleetCopyAlerts?.rebuilt).toMatchObject({ dm: 'sent', text: h.sent[0] });
    docker.copy = 'true|streaming|7001|1|0/4000000';
    await runFleetCopyTick(clock + 6 * 60_000);
    expect(bot().fleetCopyAlerts?.rebuilt).toMatchObject({ dm: 'sent', text: h.sent[0] });
  });

  it('F7: an operator Re-seed that stopped after the old copy was deleted sends one message', async () => {
    writeRegistry({ fleetDbReplica: { ...REPLICA, copyCleared: true }, fleetDbReplicaSeed: clearedSeed(clock - 5 * 60_000, { lastError: 'pg_basebackup failed: could not connect' }) });
    await runFleetCopyTick(clock);
    expect(h.sent).toEqual(['A Re-seed of the live database copy on copy.invalid stopped after the old copy was deleted: pg_basebackup failed: could not connect. That machine holds no copy of the database until a Re-seed in its manager finishes.']);
    await runFleetCopyTick(clock + 6 * 60_000);
    expect(h.sent).toHaveLength(1);
    expect(destructive()).toEqual([]);
  });
});

const builtSeed = (over: Record<string, unknown> = {}) => ({
  purpose: 'reseed-standby', phase: 'starting', startedAt: 5, updatedAt: 5, primaryHost: 'main.invalid', primaryPort: 15432,
  slot: 'fleet_standby_b', committed: true, auto: true, rebuildCause: 'slot', safetyDump: 'copy-pre-rebuild-x.dump', ...over,
});

describe('round 2 fixes', () => {
  it('N1: a rebuild the manager restarted while its copy was starting stores the message at boot, and the next check sends it', async () => {
    writeRegistry({ fleetDbReplica: { ...REPLICA, seededBy: 5 }, fleetDbReplicaSeed: builtSeed() });
    await fleetReplica.parkInterruptedReplicaSeeds();
    expect(bot().fleetDbReplicaSeed).toBeUndefined();
    expect(bot().fleetCopyAlerts?.rebuilt).toMatchObject({ kind: 'rebuilt', since: 5, dm: 'pending' });
    expect(bot().fleetCopyAlerts!.rebuilt.text).toMatch(/^The live database copy on copy\.invalid was rebuilt from the main on .* UTC: the main had stopped keeping the changes it was missing\. A backup of the old copy is kept on that machine as copy-pre-rebuild-x\.dump\.$/);
    docker.copy = 'true|streaming|7001|1|0/4000000';
    await runFleetCopyTick(clock);
    expect(h.sent).toEqual([bot().fleetCopyAlerts!.rebuilt.text]);
  });

  it('R1: a dismissed rebuild whose copy was built clears the seed and stores and sends no message', async () => {
    writeRegistry({ fleetDbReplica: { ...REPLICA, seededBy: 5 }, fleetDbReplicaSeed: builtSeed({ parked: true, lastError: 'standby service start failed: x' }) });
    const r = await fleetReplica.cancelReplicaSeed(bot(), { startedAt: 5, parked: true, committed: true, confirm: true });
    expect(r).toMatchObject({ success: true, dismissed: true });
    expect(bot().fleetDbReplicaSeed).toBeUndefined();
    expect(bot().fleetCopyAlerts).toBeUndefined();
    docker.copy = 'true|streaming|7001|1|0/4000000';
    await runFleetCopyTick(clock);
    expect(h.sent.filter(t => /rebuilt from the main/.test(t))).toEqual([]);
  });

  it('N1: a boot that parks a run whose copy was not built stores no message', async () => {
    writeRegistry({ fleetDbReplica: { ...REPLICA, copyCleared: true }, fleetDbReplicaSeed: builtSeed({ phase: 'seeding' }) });
    await fleetReplica.parkInterruptedReplicaSeeds();
    expect(bot().fleetDbReplicaSeed?.parked).toBe(true);
    expect(bot().fleetCopyAlerts).toBeUndefined();
  });

  it('N2: a cleared copy whose slot the main keeps, held after a stopped run, says the copy was deleted, not that the slot is gone', async () => {
    docker.main.slot = 'kept';
    writeRegistry({ fleetDbReplica: { ...REPLICA, copyCleared: true, autoRebuildHeldAt: '2026-10-20T00:00:00.000Z' } });
    await runFleetCopyTick(clock);
    const reason = 'automatic rebuilding is off for this copy since a rebuild was cancelled or dismissed on 2026-10-20';
    expect(h.sent).toEqual([`The live database copy on copy.invalid was deleted by a rebuild or Re-seed that stopped, and it was not rebuilt automatically: ${reason}. Its manager waits for a Re-seed: open that machine's manager to press Re-seed.`]);
    expect(rebuildView(bot())).toMatchObject({ kind: 'held', text: `This copy was deleted by a rebuild or Re-seed that stopped, and it was not rebuilt automatically: ${reason}. The manager waits for a Re-seed here: press Re-seed to rebuild it.` });
    expect(destructive()).toEqual([]);
  });

  it('N4: a copy emptied by a stopped Re-seed is rebuilt, and the message, the panel and the log name that cause', async () => {
    docker.main.slot = 'kept';
    writeRegistry({ fleetDbReplica: { ...REPLICA, copyCleared: true } });
    const log = vi.spyOn(console, 'log');
    await runFleetCopyTick(clock);
    const after = await settled();
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]).toMatch(/^The live database copy on copy\.invalid was rebuilt from the main on .* UTC: the copy had been emptied by a Re-seed or rebuild that stopped\.$/);
    expect((await fleetReplica.getFleetReplicaStatus(after)).seedNote).toMatch(/^The copy was rebuilt from the main on .* UTC: it had been emptied by a Re-seed or rebuild that stopped\. The owner was sent a Discord message\.$/);
    expect(log.mock.calls.map(c => c[0])).toContain('[FleetCopy] B: rebuilding the copy: it had been emptied by a Re-seed or rebuild that stopped (slot fleet_standby_b kept)');
    log.mockRestore();
  });

  it('N4: the run records why it started (a cleared copy)', async () => {
    writeRegistry({ fleetDbReplica: { ...REPLICA, copyCleared: true } });
    expect(fleetReplica.startAutoRebuild(bot(), 'kept', async () => false)).toEqual({ started: true });
    expect(bot().fleetDbReplicaSeed).toMatchObject({ auto: true, rebuildCause: 'cleared' });
    await settled();
  });

  it('N4: the run records why it started (the slot)', async () => {
    expect(fleetReplica.startAutoRebuild(bot(), 'absent', async () => false)).toEqual({ started: true });
    expect(bot().fleetDbReplicaSeed).toMatchObject({ auto: true, rebuildCause: 'slot' });
    await settled();
  });

  it('N5: the window shows the stored rebuild message and its outcome after a restart', async () => {
    const since = Date.parse('2026-10-27T10:00:00.000Z');
    writeRegistry({ fleetCopyAlerts: { rebuilt: { kind: 'rebuilt', text: 'x', since, dm: 'failed', dmAt: clock, dmError: 'the bot on this machine is not running' } } });
    expect(rebuildView(bot())).toMatchObject({ rebuilt: 'The copy was rebuilt automatically (the run started 2026-10-27 10:00 UTC). The owner could not be messaged: the bot on this machine is not running. The manager tries again every hour.' });
    patchRegistry({ fleetCopyAlerts: { rebuilt: { kind: 'rebuilt', text: 'x', since, dm: 'sent', dmAt: clock } } });
    expect(rebuildView(bot())).toMatchObject({ rebuilt: 'The copy was rebuilt automatically (the run started 2026-10-27 10:00 UTC). The owner was sent a Discord message.' });
    patchRegistry({ fleetCopyAlerts: { rebuilt: { kind: 'rebuilt', text: 'x', since, dm: 'pending' } } });
    expect(rebuildView(bot())).toMatchObject({ rebuilt: null });
    expect((await fleetReplica.getFleetReplicaStatus(bot())).rebuiltShown).toBeUndefined();
  });

  it('N5: the seed note of the same run already carries the outcome, and the status says so', async () => {
    await runFleetCopyTick(clock);
    const after = await settled();
    expect((await fleetReplica.getFleetReplicaStatus(after)).rebuiltShown).toBe(true);
  });

  it('N7: a message outcome that arrives after the copy was adopted as the main is not written back', async () => {
    docker.main.timeline = 2;
    let release!: () => void;
    h.gate = new Promise<void>(r => { release = r; });
    const tick = runFleetCopyTick(clock);
    for (let i = 0; i < 1000 && h.sent.length === 0; i++) await new Promise(r => setTimeout(r, 5));
    expect(h.sent).toHaveLength(1);
    expect(containerManager.adoptFleetDbReplicaAsPrimary('b')).toEqual({ success: true });
    release();
    await tick;
    expect(bot().fleetDb).toBeDefined();
    expect(bot().fleetCopyAlerts).toBeUndefined();
    expect(rebuildView(bot())).toBeNull();
  });

  it('N7: an outcome for a case that was replaced meanwhile is not written over the new one', async () => {
    docker.main.timeline = 2;
    let release!: () => void;
    h.gate = new Promise<void>(r => { release = r; });
    const tick = runFleetCopyTick(clock);
    for (let i = 0; i < 1000 && h.sent.length === 0; i++) await new Promise(r => setTimeout(r, 5));
    const newer = { kind: 'held' as const, text: 'newer', since: clock + 1, dm: 'pending' as const };
    containerManager.updateInstanceFleetCopyAlert('b', 'held', newer);
    release();
    await tick;
    expect(bot().fleetCopyAlerts?.held).toEqual(newer);
  });
});

const SEEDED_AT = Date.UTC(2026, 0, 2, 3, 4);

describe('round 3 fixes', () => {
  it('R1: the boot settle dates the message at the rebuild, not at the store', async () => {
    writeRegistry({ fleetDbReplica: { ...REPLICA, seededBy: 5, seededAt: SEEDED_AT }, fleetDbReplicaSeed: builtSeed() });
    await fleetReplica.parkInterruptedReplicaSeeds();
    expect(bot().fleetCopyAlerts!.rebuilt.text).toMatch(/rebuilt from the main on 2026-01-02 03:04 UTC:/);
  });

  it('R1: the run settle dates the message at the rebuild, not at the store', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(SEEDED_AT);
    h.onApply = () => { now.mockReturnValue(SEEDED_AT + 3 * 86_400_000); };
    try {
      await runFleetCopyTick(SEEDED_AT);
      await settled();
    } finally {
      now.mockRestore();
    }
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]).toMatch(/rebuilt from the main on 2026-01-02 03:04 UTC:/);
  });

  it('R2: a sent message of the same run is left sent when the boot settle runs again', async () => {
    const sent = { kind: 'rebuilt' as const, text: 'old', since: 5, dm: 'sent' as const, dmAt: 6 };
    writeRegistry({ fleetDbReplica: { ...REPLICA, seededBy: 5 }, fleetDbReplicaSeed: builtSeed(), fleetCopyAlerts: { rebuilt: sent } });
    await fleetReplica.parkInterruptedReplicaSeeds();
    expect(bot().fleetDbReplicaSeed).toBeUndefined();
    expect(bot().fleetCopyAlerts?.rebuilt).toEqual(sent);
  });
});
