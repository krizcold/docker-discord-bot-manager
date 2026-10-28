import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'b22-2-seed-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return {
    dir,
    refuseClear: false,
    refusePark: false,
    refuseMark: false,
    probeOk: true,
  };
});

// A fake docker: inspect says the standby is not running, exec answers a
// streaming standby, every run exits 0, and the primary probe answers f.
vi.mock('child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('child_process')>();
  const { EventEmitter } = await import('events');
  const { PassThrough } = await import('stream');
  const execFile = (_cmd: string, args: string[], opts: any, cb?: any) => {
    const done = typeof opts === 'function' ? opts : cb;
    if (args[0] === 'inspect') return done(null, 'false\n', '');
    if (args[0] === 'exec') return done(null, 't|streaming|t|0\n', '');
    if (args[0] === 'volume' && args[1] === 'inspect') return done(new Error('fail'), '', 'Error: No such volume');
    done(null, '', '');
  };
  const exec = (_cmd: string, opts: any, cb?: any) => {
    const done = typeof opts === 'function' ? opts : cb;
    done(null, { stdout: '', stderr: '' });
  };
  const spawn = (_cmd: string, args: string[]) => {
    const child: any = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.kill = () => {};
    const probe = args.includes('SELECT pg_is_in_recovery()');
    setTimeout(() => {
      child.stdout.end(probe && h.probeOk ? 'f\n' : '');
      child.stderr.end(probe && !h.probeOk ? 'psql: error: connection refused (fake)\n' : '');
      setTimeout(() => child.emit('close', probe && !h.probeOk ? 2 : 0), 1);
    }, 1);
    return child;
  };
  const execFileSync = (cmd: string, args: string[], opts: any) => {
    if (args[0] === 'volume' && args[1] === 'inspect') throw Object.assign(new Error('fail'), { stderr: 'Error: No such volume' });
    return real.execFileSync(cmd, args, opts);
  };
  const heldSpawn = (await import('./dump-fake')).withDumpHolder(spawn as any);
  return { ...real, execFile, execFileSync, exec, spawn: heldSpawn, default: { ...real, execFile, execFileSync, exec, spawn: heldSpawn } };
});
vi.mock('../../src/docker/containerManager', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/docker/containerManager')>();
  return {
    ...real,
    deployedComposeExists: () => true,
    applyFleetDbReplicaService: async () => ({ success: true }),
    markPendingApplyIfRunning: async () => { if (h.refuseMark) throw new Error('ENOSPC: no space left on device'); },
    removeFleetDbReplicaService: async () => ({ success: true }),
    updateInstanceFleetDbReplicaSeed: (id: string, rec: any) => {
      if (rec === null && h.refuseClear) throw new Error('ENOSPC: no space left on device');
      if (rec?.parked && h.refusePark) throw new Error('ENOSPC: no space left on device');
      return real.updateInstanceFleetDbReplicaSeed(id, rec);
    },
  };
});
vi.mock('../../src/instance/appHookClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/instance/appHookClient')>()),
  hasAppHooks: () => false,
}));
vi.mock('../../src/instance/appHookClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/instance/appHookClient')>()),
  capabilityRefusal: () => null,
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


import * as fs from 'fs';
import * as path from 'path';
import * as containerManager from '../../src/docker/containerManager';
import * as fleetReplica from '../../src/instance/fleetReplica';
import * as fleetBackup from '../../src/instance/fleetBackup';
import { certSource } from '../../src/instance/fleetJoin';
import { fixtureCert, joinRecordFor } from './join-fake';

beforeEach(() => { certSource.fetch = fixtureCert; });
const { cancelReplicaSeed, getFleetReplicaStatus, provisionFleetReplica, removeFleetReplica } = fleetReplica;
const retryHeldSeedRecords = (): void => (fleetReplica as any).retryHeldSeedRecords?.();

const writeRegistry = (b1: Record<string, unknown> = {}): void => {
  fs.writeFileSync(path.join(h.dir, 'instances.json'), JSON.stringify({
    instances: {
      b1: {
        id: 'b1', sanitizedName: 'bot1', displayName: 'Bot 1', titleName: 'Bot 1', status: 'running',
        sourceType: 'git', sourceUrl: 'https://example.invalid/fake/super-modular-discord-bot',
        envVars: {},
        fleetJoin: joinRecordFor('postgresql://replicator:fakepass@primary.invalid:5433/smdb'),
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

beforeEach(async () => {
  await waitFor(() => containerManager.isBotBusy('b1') === null);
  fs.rmSync(path.join(h.dir, 'bots'), { recursive: true, force: true });
  fs.mkdirSync(path.join(h.dir, 'bots', 'b1', 'env'), { recursive: true });
  h.refuseClear = false;
  h.refusePark = false;
  h.refuseMark = false;
  h.probeOk = true;
  retryHeldSeedRecords();
  writeRegistry();
});

afterAll(() => {
  fs.rmSync(h.dir, { recursive: true, force: true });
});

describe('R40-J3: a seed whose success clear is refused reads finished', () => {
  it('names the pending clear, frees the remove guard, and the minute retry clears it', async () => {
    h.refuseClear = true;
    const started = provisionFleetReplica(bot(), 'standby.invalid', 5440, true);
    expect(started.success).toBe(true);
    await waitFor(() => containerManager.isBotBusy('b1') === null);
    expect(bot().fleetDbReplica?.seededBy).toBe(bot().fleetDbReplicaSeed?.startedAt);
    const status = await getFleetReplicaStatus(bot());
    expect(status.provisioning).toBeUndefined();
    expect(status.seedNote).toMatch(/^The standby was provisioned; its seed record could not be cleared \(ENOSPC/);
    const removal = await removeFleetReplica(bot());
    expect(removal.error ?? '').not.toMatch(/Provisioning is running/);
    h.refuseClear = false;
    retryHeldSeedRecords();
    expect(bot().fleetDbReplicaSeed).toBeUndefined();
  });

  it('lets Dismiss clear the pending record', async () => {
    h.refuseClear = true;
    provisionFleetReplica(bot(), 'standby.invalid', 5440, true);
    await waitFor(() => containerManager.isBotBusy('b1') === null);
    const startedAt = bot().fleetDbReplicaSeed!.startedAt;
    h.refuseClear = false;
    const res = await cancelReplicaSeed(bot(), { startedAt, parked: true });
    expect(res).toMatchObject({ success: true, dismissed: true });
    expect(bot().fleetDbReplicaSeed).toBeUndefined();
  });
});

describe('R39-J2: a seed whose park write is refused holds the park', () => {
  it('reads parked with the refused write named, and Dismiss works', async () => {
    h.probeOk = false;
    h.refusePark = true;
    provisionFleetReplica(bot(), 'standby.invalid', 5440, true);
    await waitFor(() => containerManager.isBotBusy('b1') === null);
    expect(bot().fleetDbReplicaSeed?.parked).toBeUndefined();
    const status = await getFleetReplicaStatus(bot());
    expect(status.provisioning).toBeUndefined();
    expect(status.parkedSeed?.lastError).toMatch(/its record could not be written \(ENOSPC/);
    h.refusePark = false;
    retryHeldSeedRecords();
    expect(bot().fleetDbReplicaSeed?.parked).toBe(true);
  });
});

describe('R43-J1: a provision whose Apply mark is refused after the standby started names Restart', () => {
  it('settles the seed and says the app needs a restart', async () => {
    h.refuseMark = true;
    provisionFleetReplica(bot(), 'standby.invalid', 5440, true);
    await waitFor(() => containerManager.isBotBusy('b1') === null);
    expect(bot().fleetDbReplicaSeed).toBeUndefined();
    expect(bot().fleetDbReplica).toBeDefined();
    const status = await getFleetReplicaStatus(bot());
    expect(status.seedNote).toMatch(/Restart the instance/);
  });
});

describe('R43-J1: a provision whose Apply mark and success clear are both refused', () => {
  it('shows the Restart note once the clear-pending note is dismissed', async () => {
    h.refuseMark = true;
    h.refuseClear = true;
    provisionFleetReplica(bot(), 'standby.invalid', 5440, true);
    await waitFor(() => containerManager.isBotBusy('b1') === null);
    const startedAt = bot().fleetDbReplicaSeed!.startedAt;
    expect((await getFleetReplicaStatus(bot())).seedNote).toMatch(/its seed record could not be cleared/);
    h.refuseClear = false;
    expect(await cancelReplicaSeed(bot(), { startedAt, parked: true })).toMatchObject({ success: true, dismissed: true });
    const after = await getFleetReplicaStatus(bot());
    expect(after.seedNote).toMatch(/Restart the instance/);
    expect(after.seedNoteStartedAt).toBe(startedAt);
    expect(await cancelReplicaSeed(bot(), { startedAt })).toMatchObject({ success: true, dismissed: true });
    expect((await getFleetReplicaStatus(bot())).seedNote).toBeUndefined();
  });
});

describe('R40-J3: other lanes read a seed held done as finished', () => {
  it('the self-update does not name a running seed', async () => {
    h.refuseClear = true;
    provisionFleetReplica(bot(), 'standby.invalid', 5440, true);
    await waitFor(() => containerManager.isBotBusy('b1') === null);
    expect(bot().fleetDbReplicaSeed).toBeDefined();
    expect(fleetBackup.databaseLaneBlocker()).toBeNull();
  });
});
