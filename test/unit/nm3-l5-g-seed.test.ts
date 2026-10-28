import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm3-l5-g-seed-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return { dir, applied: 0, applyFail: '', marks: 0, envWriteFail: '' };
});

vi.mock('child_process', async (importOriginal) => (await import('./join-fake')).childProcessMock(await importOriginal<typeof import('child_process')>()));
vi.mock('../../src/casaos/detector', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/casaos/detector')>()),
  getDeploymentMode: async () => 'docker',
}));
vi.mock('../../src/docker/dockerClient', async (importOriginal) => {
  const { docker } = await import('./join-fake');
  return { ...(await importOriginal<typeof import('../../src/docker/dockerClient')>()), volumeState: () => (docker.volumeExists ? 'exists' : 'absent') };
});
vi.mock('../../src/env/manager', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/env/manager')>();
  return {
    ...real,
    setEnvVars: (id: string, vars: Record<string, string>) => {
      if (h.envWriteFail) throw new Error(h.envWriteFail);
      return real.setEnvVars(id, vars);
    },
  };
});
vi.mock('../../src/docker/containerManager', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/docker/containerManager')>();
  return {
    ...real,
    deployedComposeExists: () => true,
    applyFleetDbReplicaService: async () => { h.applied++; return h.applyFail ? { success: false, error: h.applyFail } : { success: true }; },
    markPendingApplyIfRunning: async () => { h.marks++; },
  };
});

import * as fs from 'fs';
import * as path from 'path';
import { parseDocument } from 'yaml';
import * as containerManager from '../../src/docker/containerManager';
import * as envManager from '../../src/env/manager';
import { certSource } from '../../src/instance/fleetJoin';
import { getFleetReplicaStatus, provisionFleetReplica } from '../../src/instance/fleetReplica';
import { addFleetPostgresReplicaService } from '../../src/templates/pcsProcessing';
import { docker, fakeJoinRecord, FIXTURE_FP, FIXTURE_PEM, resetDocker } from './join-fake';

const SMDB = 'https://example.invalid/fake/super-modular-discord-bot';
const REGISTRY = path.join(h.dir, 'instances.json');
const writeRegistry = (over: Record<string, unknown> = {}) => fs.writeFileSync(REGISTRY, JSON.stringify({ instances: { b: {
  id: 'b', sanitizedName: 'b', displayName: 'B', titleName: 'B', status: 'running', sourceType: 'git', sourceUrl: SMDB,
  envVars: { DATA_BACKEND: 'postgres' }, createdAt: '2026-10-24T00:00:00.000Z', updatedAt: '2026-10-24T00:00:00.000Z',
  fleetJoin: fakeJoinRecord(), ...over,
} } }, null, 2));
const bot = () => containerManager.getBot('b')!;
const settled = async () => {
  for (let i = 0; i < 400; i++) {
    const seed = containerManager.getBot('b')?.fleetDbReplicaSeed;
    if (!seed || seed.parked) return containerManager.getBot('b')!;
    await new Promise(r => setTimeout(r, 10));
  }
  throw new Error('the seed did not settle');
};
const realFetch = certSource.fetch;

beforeEach(() => {
  resetDocker();
  h.applied = 0; h.applyFail = ''; h.marks = 0; h.envWriteFail = '';
  certSource.fetch = async () => ({ ok: true, pem: FIXTURE_PEM, fp: FIXTURE_FP });
  fs.rmSync(path.join(h.dir, 'bots'), { recursive: true, force: true });
  fs.mkdirSync(path.join(h.dir, 'bots', 'b', 'env'), { recursive: true });
  writeRegistry();
});
afterAll(() => {
  certSource.fetch = realFetch;
  fs.rmSync(h.dir, { recursive: true, force: true });
});

describe('NM3 L5 g: the intake and the records a seed writes', () => {
  it('trims the public host and stamps the app identity on the record', async () => {
    expect(provisionFleetReplica(bot(), '  copy.invalid  ', 15433)).toEqual({ success: true, started: true });
    const after = await settled();
    expect(after.fleetDbReplica).toMatchObject({ publicHost: 'copy.invalid', hostPort: 15433, certHost: 'copy.invalid', user: 'smdb', db: 'smdb' });
  });

  it('starts without a public host', async () => {
    expect(provisionFleetReplica(bot(), undefined)).toEqual({ success: true, started: true });
    await settled();
  });

  it('refuses a host that is not a bare hostname', () => {
    expect(provisionFleetReplica(bot(), 'copy invalid', 15433)).toEqual({ success: false, error: 'Public host must be a bare hostname or IPv4 address' });
  });

  it('a parked seed keeps the address it was started with', async () => {
    docker.slotFail = 'ERROR:  no';
    provisionFleetReplica(bot(), 'copy.invalid', 15433);
    const after = await settled();
    expect(after.fleetDbReplicaSeed).toMatchObject({ parked: true, publicHost: 'copy.invalid', hostPort: 15433 });
  });
});

describe('NM3 L5 g: the run of a first provision', () => {
  it('joins two notes with a space and shows no rebuild', async () => {
    docker.registerFail = 'ERROR:  denied';
    h.envWriteFail = 'EROFS';
    provisionFleetReplica(bot(), 'copy.invalid', 15433);
    const after = await settled();
    const s = await getFleetReplicaStatus(after);
    expect(s.seedNote).toBe("The copy runs, but its address could not be added to the main's list (ERROR:  denied); the manager tries again every hour. The join code is saved, but the Database URL could not be written (EROFS). The manager writes it again within 5 minutes; press Join again to try now.");
    expect(s.rebuiltShown).toBeUndefined();
  });

  it('a cancel filed before the run begins reads nothing from the main', async () => {
    let fetched = 0;
    const real = containerManager.withExternalBotOp;
    const lock = vi.spyOn(containerManager, 'withExternalBotOp').mockImplementation(((id: string, op: string, fn: () => Promise<unknown>) => new Promise(r => setTimeout(r, 0)).then(() => real(id, op as never, fn as never))) as never);
    certSource.fetch = async () => { fetched++; return { ok: true, pem: FIXTURE_PEM, fp: FIXTURE_FP }; };
    provisionFleetReplica(bot(), 'copy.invalid', 15433);
    containerManager.updateInstanceFleetDbReplicaSeed('b', { ...bot().fleetDbReplicaSeed!, cancelRequested: true });
    await settled();
    expect(fetched).toBe(0);
    lock.mockRestore();
  });

  it('a cancel filed while the main is probed stops before the slot', async () => {
    certSource.fetch = async () => {
      containerManager.updateInstanceFleetDbReplicaSeed('b', { ...bot().fleetDbReplicaSeed!, cancelRequested: true });
      return { ok: true, pem: FIXTURE_PEM, fp: FIXTURE_FP };
    };
    provisionFleetReplica(bot(), 'copy.invalid', 15433);
    await settled();
    expect(docker.events).not.toContain('slot');
    expect(bot().fleetDbReplicaSeed).toBeUndefined();
  });

  it('a volume another instance claims while the main is probed stops the run before anything is cleared', async () => {
    certSource.fetch = async () => {
      const reg = JSON.parse(fs.readFileSync(REGISTRY, 'utf-8'));
      reg.instances.o = { id: 'o', displayName: 'O', sanitizedName: 'o', projectVolumes: ['b-fleet-postgres-replica-data'] };
      fs.writeFileSync(REGISTRY, JSON.stringify(reg));
      return { ok: true, pem: FIXTURE_PEM, fp: FIXTURE_FP };
    };
    expect(provisionFleetReplica(bot(), 'copy.invalid', 15433)).toEqual({ success: true, started: true });
    const after = await settled();
    expect(after.fleetDbReplicaSeed?.lastError).toBe('the seed stopped before clearing the replica volume b-fleet-postgres-replica-data: instance O (o) uses it');
    expect(docker.events).not.toContain('slot');
  });

  it('a first provision whose wipe fails drops its slot', async () => {
    docker.wipeFail = 'rm: busy';
    provisionFleetReplica(bot(), 'copy.invalid', 15433);
    await settled();
    expect(docker.events).toContain('drop-slot');
  });
});
