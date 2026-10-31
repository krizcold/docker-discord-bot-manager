import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm5-l5-j-remove-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return { dir, envWriteFail: '' };
});

vi.mock('child_process', async (importOriginal) => (await import('./join-fake')).childProcessMock(await importOriginal<typeof import('child_process')>()));
vi.mock('../../src/casaos/detector', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/casaos/detector')>()),
  getDeploymentMode: async () => 'docker',
}));
vi.mock('../../src/instance/fleetJoin', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/instance/fleetJoin')>()),
  writeEnvList: async () => ({ addresses: { state: 'applied' } }),
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

describe('the list offer after Remove replica', () => {
  it('the bot answer alone is the warning, trimmed', async () => {
    expect(await removeFleetReplica(bot())).toEqual({ success: true, warning: 'The running bot took the new database list.' });
  });

  it('the bot answer follows the address warning', async () => {
    docker.unregisterFail = 'ERROR:  boom';
    expect(await removeFleetReplica(bot())).toEqual({ success: true, warning: "; its address could not be taken off the main's list (ERROR:  boom), and the main stops listing it once the slot is dropped there. The running bot took the new database list." });
  });
});
