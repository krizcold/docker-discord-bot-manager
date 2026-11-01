import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm10-l5-d-replica-'));
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
import { codeFor, docker, fakeJoinRecord, FIXTURE_FP, FIXTURE_PEM, joinRecordFor, resetDocker } from './join-fake';

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

const SAMEHOST = (name: string) => `That primary ("${name}") lives on THIS machine, so a standby here survives that database's container dying but not this machine dying. That shape is allowed. Check the standby reports streaming once it finishes: a container that shares a docker network with the primary's sidecar cannot always reach its published port, and the copy can seed over a path the running standby does not have`;
const OWN_CODE = 'That join code is this instance\'s own database, which is the stale one. Paste the join code from the machine that now serves the fleet';
const withOther = (over: Record<string, unknown>) => {
  const reg = JSON.parse(fs.readFileSync(REGISTRY, 'utf-8'));
  reg.instances.c = { id: 'c', sanitizedName: 'c', displayName: 'C', titleName: 'C', status: 'stopped', sourceType: 'git', sourceUrl: SMDB,
    createdAt: '2026-10-24T00:00:00.000Z', updatedAt: '2026-10-24T00:00:00.000Z', ...over };
  fs.writeFileSync(REGISTRY, JSON.stringify(reg, null, 2));
};
const primaryOfC = (publicHost: string, hostPort: number) => ({
  fleetDb: { containerName: 'c-fleet-postgres', user: 'smdb', db: 'smdb', volume: 'c-pgdata', replication: { publicHost, hostPort } },
});

describe('Provision: a main this manager hosts', () => {
  beforeEach(() => writeRegistry({ fleetDbReplica: undefined, fleetJoin: joinRecordFor('postgresql://replicator:pw@MAIN.invalid:5441/smdb') }));

  it('the same host in another case and the same port asks to confirm, naming that instance', async () => {
    withOther(primaryOfC('Main.Invalid', 5441));
    expect(fleetReplica.provisionFleetReplica(bot(), 'copy.invalid', 15433)).toEqual({ success: false, needsConfirm: true, error: SAMEHOST('C') });
  });
  it('another host on the same port does not ask', async () => {
    withOther(primaryOfC('other.invalid', 5441));
    const r = fleetReplica.provisionFleetReplica(bot(), 'copy.invalid', 15433);
    expect(r.needsConfirm).toBeUndefined();
    expect(r.error ?? '').not.toContain('lives on THIS machine');
    await settled();
  }, 20000);
  it('the same host on another port does not ask', async () => {
    withOther(primaryOfC('main.invalid', 5442));
    const r = fleetReplica.provisionFleetReplica(bot(), 'copy.invalid', 15433);
    expect(r.needsConfirm).toBeUndefined();
    expect(r.error ?? '').not.toContain('lives on THIS machine');
    await settled();
  }, 20000);
});

describe('the stale-primary re-seed: its own host on another port', () => {
  const STALE = { containerName: 'b-fleet-postgres', user: 'smdb', db: 'smdb', volume: 'b-pgdata', replication: { publicHost: 'self.invalid', hostPort: 5440 } };
  beforeEach(() => writeRegistry({ status: 'stopped', fleetDbReplica: undefined, fleetJoin: undefined, fleetDb: STALE }));

  it('is not taken for its own join code', async () => {
    const r = fleetReplica.reseedStalePrimary(bot(), codeFor('postgresql://replicator:pw@self.invalid:5439/smdb'), 'standby.invalid', 5441);
    expect(r.error).not.toBe(OWN_CODE);
    expect(r.needsConfirm).toBeUndefined();
    await idle();
    await settled();
  }, 20000);
});
