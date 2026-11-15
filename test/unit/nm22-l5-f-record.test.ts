import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm22-l5-f-record-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return { dir, docker: [] as string[], gate: null as Promise<void> | null, entered: null as (() => void) | null };
});

const fail = (stderr: string): Error => Object.assign(new Error(stderr), { stderr });
const answer = (args: string[]): string => {
  const line = args.join(' ');
  h.docker.push(line);
  if (line.startsWith('image inspect')) throw fail('Error: No such image: x');
  if (line.startsWith('volume inspect')) throw fail('Error: No such volume: x');
  if (line.startsWith('volume rm')) throw fail('Error: No such volume: x');
  return '';
};

vi.mock('child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('child_process')>();
  const execFileSync = (_f: string, args: string[]) => answer(args);
  const execFile = (_f: string, args: string[], opts: any, cb?: any) => {
    const done = typeof opts === 'function' ? opts : cb;
    try { done(null, { stdout: answer(args), stderr: '' }); } catch (e) { done(e); }
  };
  const exec = (cmd: string, opts: any, cb?: any) => {
    const done = typeof opts === 'function' ? opts : cb;
    h.docker.push(cmd);
    if (cmd.startsWith('docker inspect')) done(new Error('Error: No such object'));
    else if (cmd.startsWith('docker rm')) done(new Error('Error: No such container'));
    else done(null, { stdout: '', stderr: '' });
  };
  const spawn = () => { throw new Error('no row spawns a process'); };
  const mod = { ...real, exec, execFile, execFileSync, execSync: () => '', spawn };
  return { ...mod, default: mod };
});
vi.mock('../../src/casaos/detector', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/casaos/detector')>()),
  getDeploymentMode: async () => 'docker',
}));
vi.mock('../../src/docker/dockerClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/docker/dockerClient')>()),
  listBotContainers: async () => [],
}));
vi.mock('../../src/webui/server', () => ({ broadcastToClients: () => {} }));
vi.mock('../../src/instance/fleetReplica', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/instance/fleetReplica')>()),
  instanceRemovalRefusal: async () => null,
}));
vi.mock('../../src/instance/fleetJoin', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/instance/fleetJoin')>()),
  mainCertificate: async () => ({ ok: true, pem: 'PEM' }),
  deleteAddress: async () => {
    if (h.gate) { h.entered?.(); await h.gate; }
    return null;
  },
}));

import * as fs from 'fs';
import * as path from 'path';
import * as containerManager from '../../src/docker/containerManager';
import { fakeJoinRecord } from './join-fake';

const ID = '7a6b5c4d-3e2f-4a1b-8c9d-0e1f2a3b4c5d';
const REGISTRY = path.join(h.dir, 'instances.json');
const LOST = 'v2:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const REPLICA = {
  containerName: 'bot1-fleet-postgres-replica', volume: 'bot1-fleet-postgres-replica-data', slot: 'fleet_standby_7a6b5c4d3e2f4a1b8c9d0e1f2a3b4c5d',
  primaryHost: 'main.invalid', primaryPort: 15432, publicHost: 'copy.example', hostPort: 5434, certHost: 'copy.example', user: 'app', db: 'app', seededAt: 1,
};

const seed = (extra: Record<string, unknown>): void => {
  fs.writeFileSync(REGISTRY, JSON.stringify({ instances: { [ID]: {
    id: ID, sanitizedName: 'bot1', displayName: 'Bot 1', titleName: 'Bot 1', status: 'stopped',
    sourceType: 'docker-image', imageRef: 'img:1', envVars: {}, lastBuiltCommit: null,
    createdAt: '2026-10-22T00:00:00.000Z', updatedAt: '2026-10-22T00:00:00.000Z', ...extra,
  } } }));
};
const stored = () => JSON.parse(fs.readFileSync(REGISTRY, 'utf-8')).instances[ID];

let logs: string[] = [];
beforeEach(() => {
  h.docker = [];
  h.gate = null;
  h.entered = null;
  fs.mkdirSync(path.join(h.dir, 'bots', 'bot1'), { recursive: true });
  logs = [];
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'log').mockImplementation((m: unknown) => { logs.push(String(m)); });
});
afterEach(() => vi.restoreAllMocks());
afterAll(() => fs.rmSync(h.dir, { recursive: true, force: true }));

describe('withoutRecordSecrets and fleetLogin', () => {
  it('a record with a login answers it with an empty password', () => {
    seed({ fleetLogin: { password: 'Own-Machine-Secret-01' } });
    const out = containerManager.withoutRecordSecrets(containerManager.getBot(ID))!;
    expect(out.fleetLogin).toEqual({ password: '' });
  });

  it('a record without a login answers none', () => {
    seed({});
    const out = containerManager.withoutRecordSecrets(containerManager.getBot(ID))!;
    expect('fleetLogin' in out).toBe(false);
  });
});

describe('the login password that no longer decrypts', () => {
  it('reads empty, and any later save writes the original ciphertext back', () => {
    seed({ fleetLogin: { password: LOST } });
    expect(containerManager.getBot(ID)!.fleetLogin).toEqual({ password: '' });
    containerManager.updateInstanceAutoUpdate(ID, true);
    expect(stored().fleetLogin.password).toBe(LOST);
  });
});

describe('updateInstanceFleetLogin', () => {
  it('a bot no longer in the registry: the exact error, and nothing is written', () => {
    seed({});
    const before = fs.readFileSync(REGISTRY, 'utf-8');
    expect(() => containerManager.updateInstanceFleetLogin('0b1c2d3e-0000-4000-8000-000000000000', { password: 'x-secret-1' })).toThrow(/^the bot is no longer in the registry$/);
    expect(fs.readFileSync(REGISTRY, 'utf-8')).toBe(before);
  });

  it('a registry that cannot be read: refused with the registry text, not the missing-bot one', () => {
    fs.writeFileSync(REGISTRY, '{ "instances": ');
    let err: unknown;
    try { containerManager.updateInstanceFleetLogin(ID, { password: 'x-secret-1' }); } catch (e) { err = e; }
    expect(String((err as Error).message)).toMatch(/instances\.json/);
    expect((err as Error).message).not.toBe('the bot is no longer in the registry');
    for (const f of fs.readdirSync(h.dir).filter(n => n.startsWith('instances.json.corrupt'))) fs.rmSync(path.join(h.dir, f), { force: true });
  });
});

describe('deleteBot', () => {
  it('with no flags it removes the data and keeps the env values', async () => {
    seed({ fleetJoin: fakeJoinRecord(), fleetLogin: { password: 'own-pw-1' } });
    await expect(containerManager.deleteBot(ID)).resolves.toBe(true);
    expect(logs).toContain(`[ContainerManager] Instance ${ID} uninstalled cleanly (keepData: false, keepEnv: true)`);
  });

  it('a second operation during the delete is refused, naming the delete', async () => {
    seed({ fleetDbReplica: REPLICA, fleetJoin: fakeJoinRecord(), fleetLogin: { password: 'own-pw-1' } });
    let release!: () => void;
    h.gate = new Promise<void>(r => { release = r; });
    const entered = new Promise<void>(r => { h.entered = r; });
    const first = containerManager.deleteBot(ID, true, true, true, true, []);
    await entered;
    let second: unknown;
    try { await containerManager.deleteBot(ID, true, true, true, true, []); } catch (e) { second = e; }
    release();
    await expect(first).resolves.toBe(true);
    expect((second as Error).message).toBe("Operation 'delete' is already in progress for this bot");
  });
});
