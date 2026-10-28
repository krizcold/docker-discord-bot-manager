import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm3-reseed-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return { dir, dumpFail: '' };
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
    dumpCopyForRebuild: async () => {
      docker.events.push('dump');
      return h.dumpFail ? { success: false, error: h.dumpFail } : { success: true, file: 'copy-pre-rebuild-x.dump' };
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
    applyFleetDbReplicaService: async () => { docker.events.push('apply'); docker.running = 'true'; return { success: true }; },
    removeFleetDbReplicaService: async () => { docker.events.push('service-out'); docker.running = 'false'; return { success: true }; },
  };
});

import * as fs from 'fs';
import * as path from 'path';
import * as containerManager from '../../src/docker/containerManager';
import * as fleetBackupGuards from '../../src/instance/fleetBackupGuards';
import { certSource } from '../../src/instance/fleetJoin';
import { reseedStandby } from '../../src/instance/fleetReplica';
import { COPY_PEM, docker, fakeJoinRecord, FIXTURE_FP, FIXTURE_PEM, resetDocker } from './join-fake';

const SMDB = 'https://example.invalid/fake/super-modular-discord-bot';
const REGISTRY = path.join(h.dir, 'instances.json');
const REPLICA = {
  containerName: 'b-fleet-postgres-replica', volume: 'b-fleet-postgres-replica-data', slot: 'fleet_standby_b',
  primaryHost: 'old.invalid', primaryPort: 15000, publicHost: 'copy.invalid', hostPort: 15433, certHost: 'copy.invalid',
  user: 'smdb', db: 'smdb', seededAt: 1, autoRebuildHeldAt: '2026-10-20T00:00:00.000Z',
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

beforeEach(() => {
  resetDocker();
  docker.copy = 'true||7001|1|0/4000000';
  h.dumpFail = '';
  certSource.fetch = async () => ({ ok: true, pem: FIXTURE_PEM, fp: FIXTURE_FP });
  fs.rmSync(path.join(h.dir, 'bots'), { recursive: true, force: true });
  fs.mkdirSync(path.join(h.dir, 'bots', 'b', 'env'), { recursive: true });
  writeRegistry();
});
afterAll(() => {
  certSource.fetch = realFetch;
  fs.rmSync(h.dir, { recursive: true, force: true });
});

describe('O8: Re-seed from the stored join', () => {
  it('dumps, takes the service out, seeds from the join\'s main, repoints the record and clears the hold (C80, C92)', async () => {
    expect(await reseedStandby(bot())).toEqual({ success: true, started: true });
    expect(bot().fleetDbReplica?.autoRebuildHeldAt).toBeUndefined();
    const after = await settled();
    expect(after.fleetDbReplicaSeed).toBeUndefined();
    expect(docker.events.filter(e => ['dump', 'service-out', 'slot', 'wipe', 'basebackup', 'apply'].includes(e))).toEqual(['dump', 'service-out', 'slot', 'wipe', 'basebackup', 'apply']);
    expect(after.fleetDbReplica).toMatchObject({ primaryHost: 'main.invalid', primaryPort: 15432 });
  });

  it.each([
    ['C75 no join (T-29)', () => writeRegistry({ fleetJoin: undefined }), "This instance has not joined a main yet: paste the main's join code first."],
    ['C75 a code that no longer decrypts (T-30)', () => writeRegistry({ fleetJoin: fakeJoinRecord({ code: '' }) }), 'The stored join code no longer decrypts (the manager encryption key changed or was lost); paste the join code again.'],
    ['C77 a promoted copy', () => { docker.statusProbe = 'f|||'; }, 'This copy has been promoted and no longer follows a primary; adopt it or remove it instead of re-seeding'],
    ['C77 a copy that is not running', () => { docker.statusProbe = null; docker.running = 'false'; }, 'The standby container is not running, so it cannot be verified as an unpromoted copy; start the instance if it is stopped, and press Build on its card, then Apply (or Start if the instance is stopped), if a stopped re-seed took the standby service out of its compose'],
    ['C78 an unreachable main (T-15)', () => { certSource.fetch = async () => ({ ok: false, reason: 'timeout' }); }, "Can't reach the main at main.invalid:15432 (timeout); nothing was changed. The main's machine must accept connections on that port. A machine that cannot open a port can be the main only when it runs alone."],
    ['C78 another certificate (T-16)', () => { certSource.fetch = async () => ({ ok: true, pem: COPY_PEM, fp: 'a'.repeat(64) }); }, `The database at main.invalid:15432 shows a certificate with fingerprint ${'a'.repeat(16)}..., not the ${FIXTURE_FP.slice(0, 16)}... in the join code, so the manager did not trust it; nothing was changed. Copy a new join code from the main's manager. If the main's certificate did not change, something else answers at that address.`],
    ['C78 a refused login (T-17)', () => { docker.main.fail = 'psql: error: FATAL:  no pg_hba.conf entry for replication connection'; }, "The main at main.invalid:15432 refused the join code's login (FATAL:  no pg_hba.conf entry for replication connection); nothing was changed. Replication may have been disabled there, or its password changed: copy a new join code from the main's manager."],
    ['C78 a main in recovery (T-18)', () => { docker.main.inRecovery = true; }, 'The database at main.invalid:15432 follows another database itself, so it cannot be joined; copy the join code from the manager of the machine that holds the main database.'],
    ['C78 another system id (T-43)', () => { docker.main.systemId = '9999'; }, 'The main in the join code (system id 9999) is not the database this copy was made from (system id 7001), so nothing was changed. To follow that database, remove this copy and add a new one.'],
    ['C81 the backup slot is held', () => { fleetBackupGuards.claimFleetBackupBusy('b'); }, "A dump, restore or replication change is running on this instance's database, so the re-seed was refused and nothing was changed; wait for it to finish, then re-seed again"],
  ])('%s refuses with nothing changed', async (_n, arrange, error) => {
    arrange();
    const before = fs.readFileSync(REGISTRY, 'utf-8');
    try {
      expect(await reseedStandby(bot())).toEqual({ success: false, error });
    } finally {
      fleetBackupGuards.releaseFleetBackupBusy('b');
    }
    expect(fs.readFileSync(REGISTRY, 'utf-8')).toBe(before);
    expect(destructive()).toEqual([]);
  });

  it('C76: a seed already running is refused', async () => {
    writeRegistry({ fleetDbReplicaSeed: { purpose: 'reseed-standby', phase: 'seeding', startedAt: 5, updatedAt: 5, primaryHost: 'main.invalid', primaryPort: 15432, slot: 'fleet_standby_b' } });
    expect(await reseedStandby(bot())).toEqual({ success: false, error: 'A seed is already running on this instance' });
  });

  it.each([
    ['another timeline', () => { docker.main.timeline = 2; }, 'The main in the join code is on timeline 2 and this copy on timeline 1, so this copy may hold changes the main lacks. Re-seed takes a dump of the copy first (kept with the backups), then replaces the copy with a fresh copy of the main.'],
    ['a main behind the copy', () => { docker.main.lsn = '0/1000000'; }, "The main in the join code is at position 0/1000000, behind this copy's 0/4000000, so this copy may hold changes the main lacks. Re-seed takes a dump of the copy first (kept with the backups), then replaces the copy with a fresh copy of the main."],
  ])('C79: %s asks first (T-44), and C80 the confirm proceeds', async (_n, arrange, question) => {
    arrange();
    expect(await reseedStandby(bot())).toEqual({ success: false, needsConfirm: true, error: question });
    expect(destructive()).toEqual([]);
    expect(await reseedStandby(bot(), { confirm: true })).toEqual({ success: true, started: true });
    await settled();
    expect(docker.events).toContain('basebackup');
  });

  it('a failed dump of the copy parks with nothing deleted (T-35)', async () => {
    h.dumpFail = 'the copy did not answer';
    await reseedStandby(bot());
    const after = await settled();
    expect(after.fleetDbReplicaSeed).toMatchObject({ parked: true, lastError: 'the safety dump of the copy failed, so nothing was deleted: the copy did not answer' });
    expect(destructive()).toEqual(['dump']);
    expect(after.fleetDbReplica?.copyCleared).not.toBe(true);
  });

  it('a copy the manager already cleared needs no dump and no running container', async () => {
    writeRegistry({ fleetDbReplica: { ...REPLICA, copyCleared: true } });
    docker.statusProbe = null;
    docker.running = 'false';
    expect(await reseedStandby(bot())).toEqual({ success: true, started: true });
    await settled();
    expect(docker.events).not.toContain('dump');
    expect(docker.events).toContain('basebackup');
  });
});
