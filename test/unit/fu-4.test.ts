import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'fu-4-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return {
    dir,
    spawns: [] as string[][],
    apply: { success: true } as { success: boolean; error?: string },
    hooks: false,
    refuseFirst: false,
    refuseReplicaClear: false,
  };
});

// A fake docker: inspect says the standby runs, exec answers a streaming standby, every run exits 0, and the primary
// probe answers f.
vi.mock('child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('child_process')>();
  const { EventEmitter } = await import('events');
  const { PassThrough } = await import('stream');
  const execFile = (_cmd: string, args: string[], opts: any, cb?: any) => {
    const done = typeof opts === 'function' ? opts : cb;
    if (args[0] === 'inspect') return done(null, 'true\n', '');
    if (args[0] === 'exec') return done(null, 't|streaming|t|0\n', '');
    if (args[0] === 'volume' && args[1] === 'inspect') return done(new Error('fail'), '', 'Error: No such volume');
    done(null, '', '');
  };
  const exec = (_cmd: string, opts: any, cb?: any) => {
    const done = typeof opts === 'function' ? opts : cb;
    done(null, { stdout: '', stderr: '' });
  };
  const spawn = (_cmd: string, args: string[]) => {
    h.spawns.push(args);
    const child: any = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.kill = () => {};
    const probe = args.includes('SELECT pg_is_in_recovery()');
    setTimeout(() => {
      child.stdout.end(probe ? 'f\n' : '');
      child.stderr.end('');
      setTimeout(() => child.emit('close', 0), 1);
    }, 1);
    return child;
  };
  const execFileSync = (cmd: string, args: string[], opts: any) => {
    if (args[0] === 'volume' && args[1] === 'inspect') throw Object.assign(new Error('fail'), { stderr: 'Error: No such volume' });
    return real.execFileSync(cmd, args, opts);
  };
  return { ...real, execFile, execFileSync, exec, spawn, default: { ...real, execFile, execFileSync, exec, spawn } };
});
vi.mock('../../src/docker/containerManager', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/docker/containerManager')>();
  return {
    ...real,
    deployedComposeExists: () => true,
    applyFleetDbReplicaService: async () => h.apply,
    markPendingApplyIfRunning: async () => {},
    removeFleetDbReplicaService: async () => ({ success: true }),
    updateInstanceFleetDbReplicaSeed: (id: string, rec: any) => {
      if (h.refuseFirst && rec && real.getBot(id)?.fleetDbReplicaSeed?.startedAt !== rec.startedAt) throw new Error('ENOSPC: no space left on device');
      return real.updateInstanceFleetDbReplicaSeed(id, rec);
    },
    updateInstanceFleetDbReplica: (id: string, rec: any) => {
      if (rec === null && h.refuseReplicaClear) throw new Error('ENOSPC: no space left on device');
      return real.updateInstanceFleetDbReplica(id, rec);
    },
  };
});
vi.mock('../../src/instance/appHookClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/instance/appHookClient')>()),
  hasAppHooks: () => h.hooks,
}));
vi.mock('../../src/instance/appHookClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/instance/appHookClient')>()),
  capabilityRefusal: () => null,
  getAppFacts: async () => ({ success: true, facts: { running: true, copyBlockCurrent: true, copyBlock: { dsn: 'postgresql://replicator:fakepass@primary.invalid:5433/smdb', cert: PEM } } }),
}));
vi.mock('../../src/instance/fleetReplication', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/instance/fleetReplication')>();
  const nodeFs = await import('fs');
  const nodePath = await import('path');
  return {
    ...real,
    generateCertPair: async (dir: string) => {
      for (const file of ['server.key', 'server.crt']) nodeFs.writeFileSync(nodePath.join(dir, file), 'fake');
      return { ok: true };
    },
  };
});
vi.mock('../../src/casaos/detector', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/casaos/detector')>()),
  getDeploymentMode: async () => 'docker',
}));

const PEM = '-----BEGIN CERTIFICATE-----\nZmFrZQ==\n-----END CERTIFICATE-----';
const DSN = 'postgresql://replicator:fakepass@primary.invalid:5433/smdb';

import * as fs from 'fs';
import * as path from 'path';
import * as containerManager from '../../src/docker/containerManager';
import * as fleetReplica from '../../src/instance/fleetReplica';
import * as fleetBackupGuards from '../../src/instance/fleetBackupGuards';
const { cancelReplicaSeed, getFleetReplicaStatus, provisionFleetReplica, reseedStalePrimary, reseedStandby, retryHeldSeedRecords } = fleetReplica;

const REPLICA = {
  containerName: 'bot1-fleet-postgres-replica', volume: 'bot1-fleet-postgres-replica-data', slot: 'fleet_standby_b1',
  primaryHost: 'primary.invalid', primaryPort: 5433, publicHost: 'standby.invalid', hostPort: 5440, certHost: 'standby.invalid',
  user: 'smdb', db: 'smdb',
};

const writeRegistry = (b1: Record<string, unknown> = {}): void => {
  fs.writeFileSync(path.join(h.dir, 'instances.json'), JSON.stringify({
    instances: {
      b1: {
        id: 'b1', sanitizedName: 'bot1', displayName: 'Bot 1', titleName: 'Bot 1', status: 'running',
        sourceType: 'git', sourceUrl: 'https://example.invalid/fake/super-modular-discord-bot',
        envVars: { BOT_NODE_ROLE: 'co-worker' },
        createdAt: '2026-10-24T00:00:00.000Z', updatedAt: '2026-10-24T00:00:00.000Z',
        ...b1,
      },
    },
  }));
};

const bot = () => containerManager.getBot('b1')!;
const waitFor = async (cond: () => boolean): Promise<void> => {
  for (let i = 0; i < 300 && !cond(); i++) await new Promise((r) => setTimeout(r, 10));
};
const slotDropped = (): boolean => h.spawns.some(a => a.join(' ').includes('SELECT pg_drop_replication_slot(slot_name)'));

beforeEach(async () => {
  await waitFor(() => containerManager.isBotBusy('b1') === null);
  fs.rmSync(path.join(h.dir, 'bots'), { recursive: true, force: true });
  fs.mkdirSync(path.join(h.dir, 'bots', 'b1', 'env'), { recursive: true });
  h.spawns.length = 0;
  h.apply = { success: true };
  h.hooks = false;
  h.refuseFirst = false;
  h.refuseReplicaClear = false;
  retryHeldSeedRecords();
  writeRegistry();
});

afterAll(() => {
  fs.rmSync(h.dir, { recursive: true, force: true });
});

describe('B22-2a: a provision whose service start fails and whose record clear is refused', () => {
  const failed = async () => {
    h.apply = { success: false, error: 'fake apply failure' };
    h.refuseReplicaClear = true;
    const started = provisionFleetReplica(bot(), DSN, PEM, 'standby.invalid', 5440, true);
    expect(started.success).toBe(true);
    await waitFor(() => containerManager.isBotBusy('b1') === null);
  };

  it('parks with the start failure and the held clear named, drops the slot, and the minute retry clears the record', async () => {
    await failed();
    expect(bot().fleetDbReplica).toBeDefined();
    const status = await getFleetReplicaStatus(bot());
    expect(status.parkedSeed?.lastError).toMatch(/^standby service start failed: fake apply failure/);
    expect(status.parkedSeed?.lastError).toMatch(/the standby record could not be cleared \(ENOSPC/);
    expect(slotDropped()).toBe(true);
    retryHeldSeedRecords();
    expect(bot().fleetDbReplica).toBeDefined();
    h.refuseReplicaClear = false;
    retryHeldSeedRecords();
    expect(bot().fleetDbReplica).toBeUndefined();
    expect(bot().fleetDbReplicaSeed?.parked).toBe(true);
  });

  it('clears the held record on Dismiss, and refuses the Dismiss while the clear is still refused', async () => {
    await failed();
    const startedAt = bot().fleetDbReplicaSeed!.startedAt;
    const refused = await cancelReplicaSeed(bot(), { startedAt, parked: true, confirm: true, committed: true });
    expect(refused.success).toBe(false);
    expect(refused.error).toMatch(/standby record .*could not be cleared/);
    expect(bot().fleetDbReplicaSeed?.startedAt).toBe(startedAt);
    h.refuseReplicaClear = false;
    const res = await cancelReplicaSeed(bot(), { startedAt, parked: true, confirm: true, committed: true });
    expect(res).toMatchObject({ success: true, dismissed: true });
    expect(bot().fleetDbReplica).toBeUndefined();
    expect(bot().fleetDbReplicaSeed).toBeUndefined();
  });

  it('asks a Dismiss question that says the held record is cleared, not kept', async () => {
    await failed();
    const startedAt = bot().fleetDbReplicaSeed!.startedAt;
    const asked = await cancelReplicaSeed(bot(), { startedAt, parked: true });
    expect(asked).toMatchObject({ success: false, needsConfirm: true });
    expect(asked.error).not.toMatch(/kept on record|keeps the copy|starts its container/);
    expect(asked.error).toMatch(/standby service did not start/);
    expect(asked.error).toMatch(/clears the standby record/);
    expect(asked.error).toMatch(/replica volume stays/);
  });

  it('never clears a record the seed did not build', async () => {
    await failed();
    containerManager.updateInstanceFleetDbReplica('b1', { ...REPLICA, seededBy: 1 } as any);
    h.refuseReplicaClear = false;
    retryHeldSeedRecords();
    expect(bot().fleetDbReplica?.seededBy).toBe(1);
  });
});

describe('B22-2s: a seed whose first record write is refused frees what its caller claimed', () => {
  it('provision answers that the seed did not start and leaves the instance free', () => {
    h.refuseFirst = true;
    const res = provisionFleetReplica(bot(), DSN, PEM, 'standby.invalid', 5440, true);
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/^The seed did not start: its record could not be saved \(ENOSPC/);
    expect(containerManager.isBotBusy('b1')).toBeNull();
    expect(bot().fleetDbReplicaSeed).toBeUndefined();
  });

  it('a stale-primary re-seed answers that the seed did not start and frees the backup slot', () => {
    writeRegistry({ status: 'stopped', fleetDb: { containerName: 'bot1-fleet-postgres', user: 'smdb', db: 'smdb', volume: 'bot1-fleet-postgres-data' } });
    h.refuseFirst = true;
    const res = reseedStalePrimary(bot(), DSN, PEM, 'standby.invalid', 5440, true);
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/^The seed did not start: its record could not be saved/);
    expect(fleetBackupGuards.claimFleetBackupBusy('b1')).toBe(true);
    fleetBackupGuards.releaseFleetBackupBusy('b1');
    expect(containerManager.isBotBusy('b1')).toBeNull();
  });

  it('a standby re-seed answers that the seed did not start, leaves the instance free and records the reason', async () => {
    h.hooks = true;
    writeRegistry({ fleetDbReplica: { ...REPLICA } });
    h.refuseFirst = true;
    const res = await reseedStandby(bot(), 'operator');
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/^The seed did not start: its record could not be saved/);
    expect(containerManager.isBotBusy('b1')).toBeNull();
    expect(bot().fleetDbReplicaSeed).toBeUndefined();
    expect(bot().fleetDbReplica?.autoReseed?.lastError).toMatch(/^The seed did not start/);
  });
});
