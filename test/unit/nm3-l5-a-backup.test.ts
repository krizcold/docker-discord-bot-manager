import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm3-l5-a-'));
  process.env.DATA_DIR = dir;
  return { dir, urls: {} as Record<string, string> };
});

vi.mock('child_process', async (importOriginal) => (await import('./nm2-docker')).childProcessMock(await importOriginal()));
vi.mock('../../src/config/appCapabilities', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/config/appCapabilities')>()),
  findAppCapabilities: (sourceUrl: string | null | undefined) => (sourceUrl === 'x' ? { companionDb: { env: { url: 'DATABASE_URL' } } } : null),
}));
vi.mock('../../src/env/manager', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/env/manager')>()),
  getEnvVars: (id: string) => ({ DATABASE_URL: h.urls[id] ?? '' }),
  getEnvVarsWithStatus: (id: string) => ({ vars: { DATABASE_URL: h.urls[id] ?? '' }, undecryptable: [], corrupt: false }),
}));
vi.mock('../../src/docker/containerManager', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/docker/containerManager')>()),
  runningInstanceContainers: async () => [],
}));
vi.mock('../../src/webui/server', () => ({ broadcastToClients: () => {} }));

import * as fs from 'fs';
import * as path from 'path';
import { resetDocker } from './nm2-docker';
import { fenceOwners } from './fence-fake';
import { PRIMARY, REPLICA, seedBot, clearRegistry, dumps, stampText, restartedManager, setNow, realNow, localAt } from './nm2-harness';

const NOW = localAt(10, 30);

beforeEach(() => {
  setNow(NOW);
  resetDocker();
  fenceOwners.clear();
  h.urls = {};
  fs.rmSync(path.join(h.dir, 'backups'), { recursive: true, force: true });
  clearRegistry();
});
afterEach(() => { realNow(); });

describe('dumpCopyForRebuild', () => {
  it('names the missing database identity of the standby record', async () => {
    seedBot({ fleetDbReplica: { ...REPLICA, user: '' } });
    const fb = await restartedManager();
    const { getBot } = await import('../../src/docker/containerManager');
    expect(await fb.dumpCopyForRebuild(getBot('a')!, 'pre-reseed-')).toEqual({
      success: false, error: 'the standby record has no database identity, so the copy could not be dumped',
    });
  });

  it('writes the safety dump in the copy family under the prefix and the time', async () => {
    seedBot({ fleetDbReplica: { ...REPLICA, seededAt: NOW - 86400000 } });
    const fb = await restartedManager();
    const { getBot } = await import('../../src/docker/containerManager');
    const name = `copy-pre-reseed-${stampText(NOW)}.dump`;
    expect(await fb.dumpCopyForRebuild(getBot('a')!, 'pre-reseed-')).toEqual({ success: true, file: name });
    expect(dumps()).toEqual([name]);
  });
});

describe('previewFleetRestore', () => {
  it('lists only the instances whose stored URL names this database', async () => {
    seedBot({ fleetDb: PRIMARY });
    seedBot({ sourceUrl: 'other-app' }, 'b');
    seedBot({}, 'c');
    seedBot({}, 'd');
    h.urls.a = 'postgresql://app:pw@bot-a-postgres:5432/app';
    h.urls.c = 'postgresql://app:pw@elsewhere:5432/app,postgresql://app:pw@bot-a-postgres:5432/app';
    h.urls.d = 'postgresql://app:pw@elsewhere:5432/app';
    const fb = await restartedManager();
    const result = await fb.previewFleetRestore('a');
    expect(result.success && result.instances.map(i => i.id).sort()).toEqual(['a', 'c']);
  });
});
