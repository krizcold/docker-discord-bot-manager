import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

// The join's reply when the running bot took the list, and a join called inside a lock the caller holds.
const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm5-l5-i-join-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return { dir, app: false as boolean | null };
});

vi.mock('child_process', async (o) => (await import('./join-fake')).childProcessMock(await o<typeof import('child_process')>()));
vi.mock('../../src/casaos/detector', async (o) => ({
  ...(await o<typeof import('../../src/casaos/detector')>()),
  getDeploymentMode: async () => 'docker',
}));
vi.mock('../../src/webui/server', () => ({ broadcastToClients: () => {} }));
vi.mock('../../src/instance/appHookClient', async (o) => ({
  ...(await o<typeof import('../../src/instance/appHookClient')>()),
  callAppHook: async () => ({ ok: true, status: 200, body: { success: true, applied: true } }),
}));
vi.mock('../../src/docker/containerManager', async (o) => ({
  ...(await o<typeof import('../../src/docker/containerManager')>()),
  markPendingApplyIfRunning: async () => undefined,
  appContainerRunning: async () => h.app,
}));

import * as fs from 'fs';
import * as path from 'path';
import * as containerManager from '../../src/docker/containerManager';
import { certSource, joinFleet } from '../../src/instance/fleetJoin';
import { fakeJoinCode, FIXTURE_FP, FIXTURE_PEM, resetDocker } from './join-fake';

const SMDB = 'https://example.invalid/fake/super-modular-discord-bot';
const REGISTRY = path.join(h.dir, 'instances.json');
const NEXT = 'Joined the main at main.invalid:15432. The bot uses the 1 database address(es) from its next start (Apply on the card, or Restart).';
const realFetch = certSource.fetch;
const bot = () => containerManager.getBot('b')!;

beforeEach(() => {
  resetDocker();
  h.app = false;
  certSource.fetch = async () => ({ ok: true, pem: FIXTURE_PEM, fp: FIXTURE_FP });
  fs.rmSync(path.join(h.dir, 'bots'), { recursive: true, force: true });
  fs.mkdirSync(path.join(h.dir, 'bots', 'b', 'env'), { recursive: true });
  fs.writeFileSync(REGISTRY, JSON.stringify({ instances: { b: {
    id: 'b', sanitizedName: 'b', displayName: 'B', titleName: 'B', status: 'running', sourceType: 'git', sourceUrl: SMDB,
    envVars: { DATA_BACKEND: 'postgres' }, createdAt: '2026-10-24T00:00:00.000Z', updatedAt: '2026-10-24T00:00:00.000Z',
  } } }, null, 2));
});
afterAll(() => {
  certSource.fetch = realFetch;
  fs.rmSync(h.dir, { recursive: true, force: true });
});

describe('joinFleet', () => {
  it('the running bot took the list: the reply says it uses the addresses now', async () => {
    h.app = true;
    expect(await joinFleet(bot(), fakeJoinCode())).toEqual({
      success: true, addressCount: 1,
      message: 'Joined the main at main.invalid:15432. The bot uses the 1 database address(es) now. The running bot took the new database list.',
    });
  });
  it('inside a lock the caller holds, the join runs', async () => {
    const r = await containerManager.withExternalBotOp('b', 'test-op', () => joinFleet(bot(), fakeJoinCode(), { inLock: true }));
    expect(r).toEqual({ success: true, message: NEXT, addressCount: 1 });
  });
  it('inside a lock, an instance no longer in the registry is not found', async () => {
    const gone = { ...bot(), id: 'zz' };
    expect(await joinFleet(gone, fakeJoinCode(), { inLock: true })).toEqual({ success: false, error: 'Bot not found' });
  });
});
