import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'b20-4vm-f-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return { dir, lift: 'lifted' as 'lifted' | 'stripped' | 'failed' | 'gone' | 'unknown' };
});

vi.mock('child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('child_process')>();
  const execFile = (_f: string, _args: string[], opts: any, cb?: any) => {
    const done = typeof opts === 'function' ? opts : cb;
    setImmediate(() => done(null, '', ''));
    return { stdin: null };
  };
  const exec = (_cmd: string, opts: any, cb?: any) => {
    const done = typeof opts === 'function' ? opts : cb;
    done(null, { stdout: '', stderr: '' });
  };
  const mod = { ...real, exec, execFile, execFileSync: () => '', execSync: () => '' };
  return { ...mod, default: mod };
});
vi.mock('../../src/webui/server', () => ({ broadcastToClients: () => {} }));
vi.mock('../../src/instance/fleetBackup', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/instance/fleetBackup')>()),
  liftConsentFence: async () => h.lift,
}));

import * as fs from 'fs';
import * as path from 'path';
import * as containerManager from '../../src/docker/containerManager';
import { dismissFailback } from '../../src/instance/fleetFailback';

const fleetDb = { containerName: 'bot1-fleet-postgres', user: 'smdb', db: 'smdb', volume: 'bot1-fleet-postgres-data' };
const run = {
  mode: 'failback', phase: 'catching-up', startedAt: 1, updatedAt: 1, standInNodeId: null, episode: null, lineage: null,
  dump: null, fence: { ok: true, error: null, at: 1, owned: true }, consentAt: null, block: null, serve: null,
  stoppedByRun: false, parked: true,
};

beforeEach(() => {
  fs.writeFileSync(path.join(h.dir, 'instances.json'), JSON.stringify({ instances: { b1: {
    id: 'b1', sanitizedName: 'bot1', displayName: 'Bot b1', status: 'running', sourceType: 'docker-image', envVars: {},
    fleetDb, fleetFailback: run, createdAt: '2026-10-25T00:00:00.000Z', updatedAt: '2026-10-25T00:00:00.000Z',
  } } }));
});

afterAll(() => {
  fs.rmSync(h.dir, { recursive: true, force: true });
});

describe('B20-4vm: a failback run whose fence lift found the volume gone or unread says so', () => {
  it('says no write fence remains when the volume is gone', async () => {
    h.lift = 'gone';
    const r = await dismissFailback(containerManager.getBot('b1')!);
    expect(r.success).toBe(true);
    expect(r.error).toMatch(/its database volume bot1-fleet-postgres-data is gone, so no write fence remains on it/);
    expect(r.error).not.toMatch(/READ-ONLY/);
  });

  it('says it cannot confirm whether the database is READ-ONLY when docker did not answer', async () => {
    h.lift = 'unknown';
    const r = await dismissFailback(containerManager.getBot('b1')!);
    expect(r.error).toMatch(/can't confirm whether the database is still READ-ONLY: docker did not answer whether its database volume bot1-fleet-postgres-data exists \(its next restore retries the lift\)/);
    expect(r.error).not.toMatch(/stays READ-ONLY/);
  });

  it('keeps the failed text for a fence that could not be lifted or stripped', async () => {
    h.lift = 'failed';
    const r = await dismissFailback(containerManager.getBot('b1')!);
    expect(r.error).toMatch(/could not be lifted or stripped, so the database stays READ-ONLY through a restart \(its next restore retries the lift\)/);
  });

  it('says nothing more when the fence was lifted', async () => {
    h.lift = 'lifted';
    expect(await dismissFailback(containerManager.getBot('b1')!)).toEqual({ success: true });
  });
});
