import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm10-l5-b-docker-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return {
    dir,
    env: {} as Record<string, Record<string, string>>,
    calls: [] as Array<{ cmd: string; opts: any }>,
    answer: (_cmd: string): string => '',
    volume: 'absent' as 'exists' | 'absent' | 'unknown',
    lift: { result: 'lifted' } as { result: string; detail?: string },
  };
});

vi.mock('child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('child_process')>();
  const exec = (cmd: string, opts: any, cb?: any) => {
    const done = typeof opts === 'function' ? opts : cb;
    h.calls.push({ cmd, opts: typeof opts === 'function' ? undefined : opts });
    let stdout: string;
    try { stdout = h.answer(cmd); } catch (e) { done(e); return; }
    done(null, { stdout, stderr: '' });
  };
  const execFile = (_f: string, _args: string[], opts: any, cb?: any) => {
    const done = typeof opts === 'function' ? opts : cb;
    done(new Error('Error: No such object'));
  };
  const execFileSync = () => { throw Object.assign(new Error('Error: No such object'), { stderr: 'Error: No such object' }); };
  const execSync = () => '';
  const mod = { ...real, exec, execFile, execFileSync, execSync };
  return { ...mod, default: mod };
});
vi.mock('../../src/casaos/detector', async (o) => ({
  ...(await o<typeof import('../../src/casaos/detector')>()),
  getDeploymentMode: async () => 'docker',
}));
vi.mock('../../src/webui/server', () => ({ broadcastToClients: () => {} }));
vi.mock('../../src/env/manager', async (o) => ({
  ...(await o<typeof import('../../src/env/manager')>()),
  getEnvVarsWithStatus: (id: string) => ({ vars: { ...(h.env[id] || {}) }, undecryptable: [], encrypted: [], corrupt: false }),
  getEnvVars: (id: string) => ({ ...(h.env[id] || {}) }),
  setEnvVars: (id: string, vars: Record<string, string>) => { h.env[id] = { ...(h.env[id] || {}), ...vars }; },
}));
vi.mock('../../src/docker/dockerClient', async (o) => ({
  ...(await o<typeof import('../../src/docker/dockerClient')>()),
  listComposeContainers: async () => [],
  volumeState: () => h.volume,
}));
vi.mock('../../src/instance/fleetBackup', async (o) => ({
  ...(await o<typeof import('../../src/instance/fleetBackup')>()),
  liftMigrateFence: async () => h.lift,
}));

import * as fs from 'fs';
import * as path from 'path';
import * as containerManager from '../../src/docker/containerManager';

const SMDB = 'https://github.com/x/fully-modular-discord-bot';
const FLEET_DB = { containerName: 'b1-fleet-postgres', user: 'smdb', db: 'smdb', volume: 'b1-fleet-postgres-data' };
const URL = 'postgresql://smdb:pw@b1-fleet-postgres:5432/smdb';
const base = (id: string, over: Record<string, unknown> = {}) => ({
  id, displayName: id.toUpperCase(), sanitizedName: id, titleName: id, sourceUrl: SMDB, sourceId: null, status: 'stopped', containerIds: [],
  envVars: {}, lastBuiltCommit: null, createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z', ...over,
});
const registryPath = path.join(h.dir, 'instances.json');
const writeRegistry = (instances: Record<string, unknown>) => fs.writeFileSync(registryPath, JSON.stringify({ instances }, null, 2));
const composePath = path.join(h.dir, 'bots', 'b1', 'docker-compose.yml');
const APP_ONLY = 'services:\n  app:\n    image: bot:latest\n    container_name: b1-app\n';
const deploy = (content: string) => { fs.mkdirSync(path.dirname(composePath), { recursive: true }); fs.writeFileSync(composePath, content); };
const ups = () => h.calls.filter(c => / up -d /.test(c.cmd)).map(c => c.cmd);

afterAll(() => fs.rmSync(h.dir, { recursive: true, force: true }));
beforeEach(() => {
  h.calls = [];
  h.answer = () => '';
  h.volume = 'absent';
  h.lift = { result: 'lifted' };
  h.env = { b1: { DATA_BACKEND: 'file', DATA_BACKEND_URL: URL } };
  fs.rmSync(path.join(h.dir, 'bots'), { recursive: true, force: true });
  writeRegistry({ b1: base('b1', { fleetDb: FLEET_DB }) });
});

describe('attachFleetDbService', () => {
  it('answers Bot not found for an unknown id', async () => {
    expect(await containerManager.attachFleetDbService('ghost')).toEqual({ success: false, error: 'Bot not found' });
  });
  it('answers the refusal ensureFleetDataBackend throws', async () => {
    writeRegistry({ b1: base('b1') });
    h.env.b1 = { DATA_BACKEND: 'file' };
    h.volume = 'exists';
    const r = await containerManager.attachFleetDbService('b1');
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/^The database volume b1-fleet-postgres-data already exists/);
  });
  it('answers that no managed database applies for an app with none', async () => {
    writeRegistry({ b1: base('b1', { sourceUrl: 'https://github.com/x/plain-app' }) });
    expect(await containerManager.attachFleetDbService('b1')).toEqual({ success: false, error: 'no managed database applies to this bot' });
  });
  it('answers that the deployed compose is missing', async () => {
    expect(await containerManager.attachFleetDbService('b1')).toEqual({ success: false, error: 'Deployed compose not found (install the instance first)' });
  });
  it('leaves a compose that already names the database container as it is, past a service with no body', async () => {
    const content = 'services:\n  side:\n  app:\n    image: bot:latest\n    container_name: b1-app\n  fleet-postgres:\n    image: postgres:16\n    container_name: b1-fleet-postgres\n';
    deploy(content);
    expect(await containerManager.attachFleetDbService('b1')).toEqual({ success: true });
    expect(fs.readFileSync(composePath, 'utf-8')).toBe(content);
    expect(ups()).toEqual([]);
  });
  it('writes the database service on the docker network and starts it', async () => {
    deploy(APP_ONLY);
    expect(await containerManager.attachFleetDbService('b1')).toEqual({ success: true });
    const compose = fs.readFileSync(composePath, 'utf-8');
    expect(compose).toContain('container_name: b1-fleet-postgres');
    expect(compose).toContain('dbm_internal');
    expect(ups()).toEqual([`docker compose -f "${composePath}" -p "b1" up -d fleet-postgres`]);
  });
  it('answers a compose it cannot read with the write text and starts nothing', async () => {
    fs.mkdirSync(composePath, { recursive: true });
    const r = await containerManager.attachFleetDbService('b1');
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/^The database service could not be written into the deployed compose, so nothing was started: /);
    expect(ups()).toEqual([]);
  });
  it('a failing up whose revert also fails says the compose still names the service', async () => {
    deploy(APP_ONLY);
    h.answer = (cmd) => {
      if (/ up -d /.test(cmd)) {
        fs.rmSync(composePath);
        fs.mkdirSync(composePath);
        throw new Error('up failed');
      }
      return '';
    };
    const r = await containerManager.attachFleetDbService('b1');
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/^Error: up failed; the deployed compose still names the database service, because restoring it failed: /);
  });
});

describe('applyFleetDbReplicaService', () => {
  it('a failing up with the compose put back answers the docker error', async () => {
    const replica = { containerName: 'b1-fleet-postgres-replica', volume: 'b1-fleet-postgres-replica-data', slot: 's1', primaryHost: 'primary.invalid', primaryPort: 5433 };
    writeRegistry({ b1: base('b1', { fleetDb: FLEET_DB, fleetDbReplica: replica }) });
    deploy(APP_ONLY);
    h.answer = (cmd) => { if (/ up -d /.test(cmd)) throw new Error('up failed'); return ''; };
    expect(await containerManager.applyFleetDbReplicaService('b1')).toEqual({ success: false, error: 'Error: up failed' });
    expect(fs.readFileSync(composePath, 'utf-8')).toBe(APP_ONLY);
  });
});

describe('deleteBot with Keep data while the record holds a pg_hba fence', () => {
  const kept = (why: string) => `The delete stopped before it removed the instance record: the lines the open migration added to the database's pg_hba.conf, which refuse every connection but this bot's and the manager's, could not be removed from the kept database volume b1-fleet-postgres-data (${why}), and a reinstall on that volume would meet them. Press Delete again to remove them and finish the delete.`;
  const record = { to: 'postgres', from: 'file', destination: null, companion: true, jobId: 'mgr-a', jobIds: ['mgr-a'], posted: true, started: 1, kept: 0, phase: 'following', loginOpened: true, sharers: [], sharersStopped: [], openedAt: '2026-10-31T00:00:00.000Z', hbaFence: 'migrate:1', hbaFenceSet: true };
  beforeEach(() => {
    writeRegistry({ b1: base('b1', { fleetDb: FLEET_DB, migrate: record }) });
  });
  it('a locked volume with no detail stops it with no reason given', async () => {
    h.lift = { result: 'locked' };
    await expect(containerManager.deleteBot('b1', true, false)).rejects.toThrow(kept('docker could not change the file in the volume (no reason given)'));
  });
  it('an unknown answer stops it saying docker did not answer', async () => {
    h.lift = { result: 'unknown' };
    await expect(containerManager.deleteBot('b1', true, false)).rejects.toThrow(kept('docker did not answer whether the volume exists'));
  });
});

describe('appContainerEnv', () => {
  const inspect = (stdout: string) => (cmd: string) => (cmd.startsWith('docker ps -q') ? 'abc123\n' : cmd.startsWith('docker inspect') ? stdout : '');
  it('answers docker did not answer when docker ps fails', async () => {
    h.answer = () => { throw new Error('no daemon'); };
    expect(await containerManager.appContainerEnv('b1', ['DATA_BACKEND'])).toEqual({ ok: false, error: 'docker did not answer' });
  });
  it('answers that the container is not running when docker ps lists none', async () => {
    expect(await containerManager.appContainerEnv('b1', ['DATA_BACKEND'])).toEqual({ ok: false, error: 'the bot container is not running' });
  });
  it('answers no env list for a null Env, with a 30 s timeout on the inspect', async () => {
    h.answer = inspect('null\n');
    expect(await containerManager.appContainerEnv('b1', ['DATA_BACKEND'])).toEqual({ ok: false, error: 'docker inspect gave no env list' });
    expect(h.calls.find(c => c.cmd.startsWith('docker inspect'))?.opts).toEqual({ timeout: 30_000 });
  });
  it('reads only the named keys, an entry with no = as blank', async () => {
    h.answer = inspect(`${JSON.stringify(['PATH=/usr/bin', 'DATA_BACKEND', `DATA_BACKEND_URL=${URL}`])}\n`);
    expect(await containerManager.appContainerEnv('b1', ['DATA_BACKEND', 'DATA_BACKEND_URL'])).toEqual({ ok: true, env: { DATA_BACKEND: '', DATA_BACKEND_URL: URL } });
  });
});
