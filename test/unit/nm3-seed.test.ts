import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm3-seed-'));
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

describe('O5: a live copy from the stored join', () => {
  it('C39: refuses without a join (T-29) and with a code that no longer decrypts (T-30)', () => {
    writeRegistry({ fleetJoin: undefined });
    expect(provisionFleetReplica(bot(), 'copy.invalid')).toEqual({ success: false, error: "This instance has not joined a main yet: paste the main's join code first." });
    writeRegistry({ fleetJoin: fakeJoinRecord({ code: '' }) });
    expect(provisionFleetReplica(bot(), 'copy.invalid')).toEqual({ success: false, error: 'The stored join code no longer decrypts (the manager encryption key changed or was lost); paste the join code again.' });
    expect(bot().fleetDbReplicaSeed).toBeUndefined();
  });

  it('seeds in the order slot, wipe, base backup, then registers its address and writes the list', async () => {
    expect(provisionFleetReplica(bot(), 'copy.invalid', 15433)).toEqual({ success: true, started: true });
    const after = await settled();
    const order = docker.events.filter(e => ['slot', 'wipe', 'basebackup', 'register'].includes(e));
    expect(order).toEqual(['slot', 'wipe', 'basebackup', 'register']);
    expect(after.fleetDbReplica).toMatchObject({ primaryHost: 'main.invalid', primaryPort: 15432, publicHost: 'copy.invalid', hostPort: 15433, certHost: 'copy.invalid' });
    expect(envManager.getEnvVars('b').DATA_BACKEND_URL!.split(',')[0]).toBe('postgresql://smdb:app%2Cpa%25ss@b-fleet-postgres-replica:5432/smdb?sslmode=no-verify');
    expect(h.marks).toBe(1);
    expect((await getFleetReplicaStatus(after)).seedNote).toBeUndefined();
  });

  it('C41: a main whose certificate changed parks before anything is deleted', async () => {
    certSource.fetch = async () => ({ ok: false, reason: 'connect ETIMEDOUT' });
    provisionFleetReplica(bot(), 'copy.invalid', 15433);
    const after = await settled();
    expect(after.fleetDbReplicaSeed?.lastError).toBe("could not verify the primary at main.invalid:15432, so nothing has been changed: Can't reach the main at main.invalid:15432 (connect ETIMEDOUT); nothing was changed. The main's machine must accept connections on that port. A machine that cannot open a port can be the main only when it runs alone.");
    expect(after.fleetDbReplicaSeed?.committed).not.toBe(true);
    expect(docker.events).not.toContain('wipe');
  });

  it('C44: a main that refuses the slot parks with nothing deleted', async () => {
    docker.slotFail = 'ERROR:  permission denied to create replication slot';
    provisionFleetReplica(bot(), 'copy.invalid', 15433);
    const after = await settled();
    expect(after.fleetDbReplicaSeed?.lastError).toBe('could not prepare the replication slot on the primary: ERROR:  permission denied to create replication slot');
    expect(after.fleetDbReplicaSeed?.committed).not.toBe(true);
    expect(docker.events).not.toContain('wipe');
  });

  it('C45: an address that cannot be registered finishes the seed with T-31', async () => {
    docker.registerFail = 'ERROR:  permission denied for table addresses';
    provisionFleetReplica(bot(), 'copy.invalid', 15433);
    const after = await settled();
    expect(after.fleetDbReplicaSeed).toBeUndefined();
    expect((await getFleetReplicaStatus(after)).seedNote).toBe("The copy runs, but its address could not be added to the main's list (ERROR:  permission denied for table addresses); the manager tries again every hour.");
  });

  it('C47: a refused env write finishes the seed with T-24', async () => {
    h.envWriteFail = 'EROFS';
    provisionFleetReplica(bot(), 'copy.invalid', 15433);
    const after = await settled();
    expect(after.fleetDbReplicaSeed).toBeUndefined();
    expect((await getFleetReplicaStatus(after)).seedNote).toBe('The join code is saved, but the Database URL could not be written (EROFS). The manager writes it again within 5 minutes; press Join again to try now.');
  });

  it('C49: a copy without an address registers nothing, names its container in its certificate, and publishes no port', async () => {
    expect(provisionFleetReplica(bot(), '')).toEqual({ success: true, started: true });
    const after = await settled();
    expect(docker.events).not.toContain('register');
    expect(after.fleetDbReplica).toMatchObject({ certHost: 'b-fleet-postgres-replica' });
    expect(after.fleetDbReplica?.publicHost).toBeUndefined();
    expect(after.fleetDbReplica?.hostPort).toBeUndefined();
    const compose = addFleetPostgresReplicaService('services:\n  app:\n    image: x\n', { id: 'b' } as any, { containerName: 'b-fleet-postgres-replica', volume: 'v' });
    expect((parseDocument(compose).toJSON() as any).services['fleet-postgres-replica'].ports).toBeUndefined();
    const withPort = addFleetPostgresReplicaService('services:\n  app:\n    image: x\n', { id: 'b' } as any, { containerName: 'b-fleet-postgres-replica', volume: 'v', hostPort: 15433 });
    expect((parseDocument(withPort).toJSON() as any).services['fleet-postgres-replica'].ports).toEqual(['15433:5432']);
  });

  it('a port taken by another database here is refused before anything starts', () => {
    fs.writeFileSync(REGISTRY, JSON.stringify({ instances: {
      b: JSON.parse(fs.readFileSync(REGISTRY, 'utf-8')).instances.b,
      o: { id: 'o', displayName: 'O', sanitizedName: 'o', fleetDbReplica: { containerName: 'o-r', volume: 'o-v', slot: 's', primaryHost: 'x', primaryPort: 1, publicHost: 'o.invalid', hostPort: 15433, certHost: 'o.invalid' } },
    } }));
    expect(provisionFleetReplica(bot(), 'copy.invalid', 15433)).toEqual({ success: false, error: 'Host port 15433 is already used by "O" - pick another' });
  });
});
