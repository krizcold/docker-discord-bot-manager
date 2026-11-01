import { afterAll, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm10-l5-r2-dburl-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return { dir, env: {} as Record<string, Record<string, string>> };
});

vi.mock('../../src/webui/server', () => ({ broadcastToClients: () => {} }));
vi.mock('../../src/env/manager', async (o) => ({
  ...(await o<typeof import('../../src/env/manager')>()),
  getEnvVarsWithStatus: (id: string) => ({ vars: { ...(h.env[id] || {}) }, undecryptable: [], encrypted: [], corrupt: false }),
  getEnvVars: (id: string) => ({ ...(h.env[id] || {}) }),
}));
vi.mock('../../src/docker/dockerClient', async (o) => ({
  ...(await o<typeof import('../../src/docker/dockerClient')>()),
  listComposeContainers: async () => [],
}));

import * as fs from 'fs';
import * as path from 'path';
import * as containerManager from '../../src/docker/containerManager';
import { readDatabaseUrl } from '../../src/config/databaseUrl';

const SMDB = 'https://github.com/x/fully-modular-discord-bot';

afterAll(() => fs.rmSync(h.dir, { recursive: true, force: true }));

describe('a Database URL made only of commas', () => {
  it('reads as no address and no form', () => {
    expect(readDatabaseUrl(',')).toEqual({ addresses: [], form: null });
  });
  it('passes the gate while the record awaits a destination', () => {
    const rec = { to: 'postgres', from: 'file', destination: null, companion: false, jobId: 'mgr-a', jobIds: ['mgr-a'], posted: true, started: 1, kept: 0, phase: 'waiting', resumeAt: 'following', awaiting: 'destination', loginOpened: false, sharers: [], sharersStopped: [], openedAt: '2026-10-31T00:00:00.000Z' };
    const inst = { id: 'b1', displayName: 'B1', sanitizedName: 'b1', titleName: 'b1', sourceUrl: SMDB, sourceId: null, status: 'stopped', containerIds: [], envVars: {}, lastBuiltCommit: null, createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z', migrate: rec };
    fs.writeFileSync(path.join(h.dir, 'instances.json'), JSON.stringify({ instances: { b1: inst } }, null, 2));
    h.env.b1 = { DATA_BACKEND: 'postgres', DATA_BACKEND_URL: '' };
    expect(containerManager.migrateEnvRefusal('b1', { vars: { DATA_BACKEND_URL: ',' } })).toBeNull();
  });
});
