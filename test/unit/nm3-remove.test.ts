import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm3-remove-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return { dir, envWriteFail: '' };
});

vi.mock('child_process', async (importOriginal) => (await import('./join-fake')).childProcessMock(await importOriginal<typeof import('child_process')>()));
vi.mock('../../src/casaos/detector', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/casaos/detector')>()),
  getDeploymentMode: async () => 'docker',
}));
vi.mock('../../src/webui/server', () => ({ broadcastToClients: () => {} }));
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
vi.mock('../../src/docker/containerManager', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/docker/containerManager')>()),
  markPendingApplyIfRunning: async () => undefined,
  removeFleetDbReplicaService: async () => ({ success: true }),
}));

import * as fs from 'fs';
import * as path from 'path';
import * as containerManager from '../../src/docker/containerManager';
import * as envManager from '../../src/env/manager';
import { certSource } from '../../src/instance/fleetJoin';
import { removeFleetReplica } from '../../src/instance/fleetReplica';
import { createBotRoutes } from '../../src/webui/routes/bots';
import { docker, fakeJoinRecord, FIXTURE_FP, FIXTURE_PEM, resetDocker } from './join-fake';

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
const MAIN_URL = `postgresql://smdb:app%2Cpa%25ss@main.invalid:15432/smdb?sslmode=verify-full&sslrootcert=/data/db-certs/${FIXTURE_FP.slice(0, 16)}.crt`;
const realFetch = certSource.fetch;

beforeEach(() => {
  resetDocker();
  h.envWriteFail = '';
  certSource.fetch = async () => ({ ok: true, pem: FIXTURE_PEM, fp: FIXTURE_FP });
  fs.rmSync(path.join(h.dir, 'bots'), { recursive: true, force: true });
  fs.mkdirSync(path.join(h.dir, 'bots', 'b', 'env'), { recursive: true });
  writeRegistry();
  envManager.setEnvVars('b', { DATA_BACKEND_URL: `postgresql://smdb:app%2Cpa%25ss@b-fleet-postgres-replica:5432/smdb?sslmode=no-verify,${MAIN_URL}` });
});
afterAll(() => {
  certSource.fetch = realFetch;
  fs.rmSync(h.dir, { recursive: true, force: true });
});

describe('O9: Remove replica takes the copy off the main\'s list and the bot\'s', () => {
  it('deletes its own address row and writes the list without the local entry', async () => {
    expect(await removeFleetReplica(bot())).toEqual({ success: true });
    expect(docker.events).toContain('unregister');
    expect(envManager.getEnvVars('b').DATA_BACKEND_URL).toBe(MAIN_URL);
    expect(bot().fleetDbReplica).toBeUndefined();
  });

  it('N8: the list is written from the join saved while the address was being deleted', async () => {
    certSource.fetch = async () => {
      containerManager.updateInstanceFleetJoin('b', fakeJoinRecord({}, { host: 'main2.invalid' }) as any);
      return { ok: true, pem: FIXTURE_PEM, fp: FIXTURE_FP };
    };
    expect((await removeFleetReplica(bot())).success).toBe(true);
    expect(envManager.getEnvVars('b').DATA_BACKEND_URL).toContain('@main2.invalid:15432/');
  });

  it('C83: a row that cannot be deleted still succeeds, with T-45 in the warning', async () => {
    docker.unregisterFail = 'ERROR:  permission denied for table addresses';
    expect(await removeFleetReplica(bot())).toEqual({ success: true, warning: "; its address could not be taken off the main's list (ERROR:  permission denied for table addresses), and the main stops listing it once the slot is dropped there" });
    expect(bot().fleetDbReplica).toBeUndefined();
  });

  it('C85: a refused env write still succeeds, with T-24 in the warning', async () => {
    h.envWriteFail = 'EROFS';
    const r = await removeFleetReplica(bot());
    expect(r.success).toBe(true);
    expect(r.warning).toBe('. The join code is saved, but the Database URL could not be written (EROFS). The manager writes it again within 5 minutes; press Join again to try now.');
  });

  it('a copy without an address deletes no row', async () => {
    const { publicHost: _p, hostPort: _h, ...noAddress } = REPLICA;
    writeRegistry({ fleetDbReplica: { ...noAddress, certHost: 'b-fleet-postgres-replica' } });
    expect(await removeFleetReplica(bot())).toEqual({ success: true });
    expect(docker.events).not.toContain('unregister');
  });

  it('C87: no record', async () => {
    writeRegistry({ fleetDbReplica: undefined });
    expect(await removeFleetReplica(bot())).toEqual({ success: false, error: 'No replica on this instance' });
  });

  it('the route adds the address warning to the slot warning', async () => {
    docker.unregisterFail = 'ERROR:  boom';
    const router = createBotRoutes({ clients: new Set() } as any);
    const layer = (router as any).stack.find((l: any) => l.route?.path === '/:id/fleet-replica' && l.route.methods.delete);
    const res: any = { statusCode: 200 };
    res.status = (c: number) => { res.statusCode = c; return res; };
    res.json = (b: unknown) => { res.body = b; return res; };
    await layer.route.stack[layer.route.stack.length - 1].handle({ params: { id: 'b' }, query: {}, body: {} }, res);
    expect(res.body).toEqual({ success: true, warning: "The primary keeps replication slot fleet_standby_b, which retains WAL until it is dropped there: its Database modal lists the slot with a Drop action once nothing streams on it; its address could not be taken off the main's list (ERROR:  boom), and the main stops listing it once the slot is dropped there" });
  });
});
