import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm2-l5e-reseed-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return {
    dir,
    removes: [] as string[],
    removeAnswer: { success: true } as { success: boolean; error?: string },
    beforeRemove: null as null | (() => void),
    /** Whether docker reports the copy's container running after a stop that succeeded. */
    afterStop: false as boolean,
    failClear: false,
  };
});

vi.mock('child_process', async (importOriginal) => {
  const mocked: any = await (await import('./nm2-docker')).childProcessMock(await importOriginal());
  const { EventEmitter } = await import('events');
  const { PassThrough } = await import('stream');
  const spawn = (cmd: string, args: string[], ...rest: unknown[]) => {
    if (!(args[0] === 'run' && args.join(' ').includes('seed-probe'))) return mocked.spawn(cmd, args, ...rest);
    const child: any = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.kill = () => true;
    setTimeout(() => { child.stdout.end('f\n'); child.stderr.end(''); setTimeout(() => child.emit('close', 0), 2); }, 1);
    return child;
  };
  return { ...mocked, spawn, default: { ...mocked.default, spawn } };
});
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
    removeFleetDbReplicaService: async (_id: string, name: string) => {
      h.removes.push(name);
      if (h.removeAnswer.success) (globalThis as any).__nm2Docker.running[name] = h.afterStop;
      return h.removeAnswer;
    },
    applyFleetDbReplicaService: async () => ({ success: true }),
    updateInstanceFleetDbReplicaSeed: (id: string, seed: any) => {
      if (seed === null && h.failClear) throw new Error('disk full');
      return real.updateInstanceFleetDbReplicaSeed(id, seed);
    },
  };
});

import * as fs from 'fs';
import { docker, resetDocker, callsWith } from './nm2-docker';
import { fenceOwners } from './fence-fake';
import { REPLICA, seedBot, clearRegistry, stored, registryPath } from './nm2-harness';
import { joinRecordFor } from './join-fake';

async function load() {
  const fr = await import('../../src/instance/fleetReplica');
  const guards = await import('../../src/instance/fleetBackupGuards');
  const cm = await import('../../src/docker/containerManager');
  return { fr, guards, cm, bot: () => cm.getBot('a')! };
}

function changeReplica(patch: Record<string, unknown>): void {
  const reg = JSON.parse(fs.readFileSync(registryPath(), 'utf-8'));
  Object.assign(reg.instances.a.fleetDbReplica, patch);
  fs.writeFileSync(registryPath(), JSON.stringify(reg, null, 2));
}

const wentOn = (): boolean => docker.calls.some(a => a[0] === 'rm' && a[2] === 'bota-fleet-replica-seed');
const settled = async (guards: { isFleetBackupBusy: (id: string) => boolean }) =>
  vi.waitFor(() => expect(guards.isFleetBackupBusy('a')).toBe(false), { timeout: 3000 });

beforeEach(() => {
  resetDocker();
  fenceOwners.clear();
  h.removes = [];
  h.removeAnswer = { success: true };
  h.failClear = false;
  h.afterStop = false;
  docker.overrides.push({ match: a => a.join(' ').includes('pg_is_in_recovery(),'), answer: { ok: true, stdout: 't|streaming|f|1\n' } });
  clearRegistry();
  seedBot({ fleetDbReplica: { ...REPLICA, seededAt: Date.now() - 86400000 }, updateToken: 'tok', fleetJoin: joinRecordFor('postgresql://replicator:fakepass@primary.example:5432/app') });
});
afterAll(() => { fs.rmSync(h.dir, { recursive: true, force: true }); });

describe('NM2 L5e: the re-seed preflight', () => {
  it('a standby proven gone is stopped, checked, and the seed goes on', async () => {
    h.afterStop = false;
    const { fr, guards, bot } = await load();
    expect(await fr.reseedStandby(bot())).toEqual({ success: true, started: true });
    await settled(guards);
    expect(h.removes).toEqual(['bot-a-replica']);
    expect(callsWith('inspect').some(a => a.includes('bot-a-replica'))).toBe(true);
    expect(wentOn()).toBe(true);
  });

  it('a standby container still running stops the seed before the wipe with its text', async () => {
    h.afterStop = true;
    const { fr, guards, bot } = await load();
    await fr.reseedStandby(bot());
    await settled(guards);
    expect(wentOn()).toBe(false);
    expect(stored().fleetDbReplicaSeed).toMatchObject({ parked: true, lastError: 'could not stop the copy: its database container is still present after the stop, so its copy cannot be cleared safely' });
  });

  it('a refused stop parks the seed with the stop error', async () => {
    h.removeAnswer = { success: false, error: 'boom' };
    const { fr, guards, bot } = await load();
    await fr.reseedStandby(bot());
    await settled(guards);
    expect(wentOn()).toBe(false);
    expect(stored().fleetDbReplicaSeed).toMatchObject({ parked: true, lastError: 'could not stop the copy: boom' });
  });

  for (const [what, patch] of [['container', { containerName: 'other-replica' }], ['volume', { volume: 'other-data' }]] as const) {
    it(`a standby record whose ${what} changed after the start is left alone and the seed record cleared`, async () => {
      docker.running['bot-a-replica'] = false;
      const { fr, guards, bot } = await load();
      await fr.reseedStandby(bot());
      changeReplica(patch);
      await settled(guards);
      expect(h.removes).toEqual([]);
      expect(wentOn()).toBe(false);
      expect(stored().fleetDbReplicaSeed).toBeUndefined();
    });
  }

  it('a superseded seed whose clear fails shows the superseded text', async () => {
    docker.running['bot-a-replica'] = false;
    h.failClear = true;
    const { fr, guards, cm, bot } = await load();
    await fr.reseedStandby(bot());
    changeReplica({ containerName: 'other-replica' });
    await settled(guards);
    expect(fr.seedView(cm.getBot('a')!)?.lastError).toBe('the standby record changed while the re-seed was starting; nothing is left to retry, so Dismiss this; its record could not be written (disk full)');
  });
});
