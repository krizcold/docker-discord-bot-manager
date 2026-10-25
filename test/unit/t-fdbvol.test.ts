import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 't-fdbvol-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return { dir, volumes: new Set<string>(), removed: [] as string[], containersRemoved: [] as string[], onComposeCleanup: null as null | (() => void) };
});

const fail = (stderr: string): Error => Object.assign(new Error(stderr), { stderr });
const answer = (args: string[]): string => {
  const line = args.join(' ');
  if (line.startsWith('image inspect')) throw fail('Error: No such image: x');
  if (args[0] === 'volume' && args[1] === 'ls') {
    const prefix = args[args.indexOf('--filter') + 1].replace(/^name=/, '');
    return [...h.volumes].filter((v) => v.includes(prefix)).join('\n');
  }
  if (args[0] === 'volume' && (args[1] === 'inspect' || args[1] === 'rm')) {
    if (!h.volumes.has(args[2])) throw fail(`Error: No such volume: ${args[2]}`);
    if (args[1] === 'rm') { h.volumes.delete(args[2]); h.removed.push(args[2]); }
    return '';
  }
  return '';
};

vi.mock('child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('child_process')>();
  const execFileSync = (_f: string, args: string[]) => answer(args);
  const execFile = (_f: string, args: string[], opts: any, cb?: any) => {
    const done = typeof opts === 'function' ? opts : cb;
    try { done(null, { stdout: answer(args), stderr: '' }); } catch (e) { done(e); }
  };
  const execSync = () => '';
  const exec = (cmd: string, opts: any, cb?: any) => {
    const done = typeof opts === 'function' ? opts : cb;
    if (cmd.startsWith('docker ps -aq') && h.onComposeCleanup) { const run = h.onComposeCleanup; h.onComposeCleanup = null; run(); }
    if (cmd.startsWith('docker inspect')) done(new Error('Error: No such object'));
    else if (cmd.startsWith('docker rm')) { h.containersRemoved.push(cmd); done(new Error('Error: No such container')); }
    else done(null, { stdout: '', stderr: '' });
  };
  const mod = { ...real, exec, execFile, execFileSync, execSync };
  return { ...mod, default: mod };
});
vi.mock('../../src/casaos/detector', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/casaos/detector')>()),
  getDeploymentMode: async () => 'docker',
}));
vi.mock('../../src/webui/server', () => ({ broadcastToClients: () => {} }));

import * as fs from 'fs';
import * as path from 'path';
import * as containerManager from '../../src/docker/containerManager';

const DB = 'bot1-fleet-postgres-data';
const REPLICA = 'bot1-fleet-postgres-replica-data';
const registryPath = path.join(h.dir, 'instances.json');
const record = (id: string, over: Record<string, unknown> = {}): any => ({
  id, sanitizedName: 'bot1', displayName: `Bot ${id}`, titleName: `Bot ${id}`, status: 'stopped',
  sourceType: 'docker-image', envVars: {},
  createdAt: '2026-10-24T00:00:00.000Z', updatedAt: '2026-10-24T00:00:00.000Z', ...over,
});
const fleetDb = { containerName: 'bot1-fleet-postgres', user: 'smdb', db: 'smdb', volume: DB };
const fleetDbReplica = {
  containerName: 'bot1-fleet-postgres-replica', volume: REPLICA, slot: 's1',
  primaryHost: 'primary.invalid', primaryPort: 5433,
};
const writeRegistry = (...instances: any[]): void => {
  fs.writeFileSync(registryPath, JSON.stringify({ instances: Object.fromEntries(instances.map((i) => [i.id, i])) }));
};
const deploy = (id: string, compose: string): void => {
  fs.mkdirSync(path.join(h.dir, 'bots', id), { recursive: true });
  fs.writeFileSync(path.join(h.dir, 'bots', id, 'docker-compose.yml'), compose);
};
const registered = (id: string): boolean => id in JSON.parse(fs.readFileSync(registryPath, 'utf-8')).instances;

beforeEach(() => {
  h.volumes = new Set([DB, REPLICA]);
  h.removed = [];
  h.containersRemoved = [];
  h.onComposeCleanup = null;
  fs.rmSync(path.join(h.dir, 'bots'), { recursive: true, force: true });
  fs.mkdirSync(path.join(h.dir, 'bots', 'b1'), { recursive: true });
});

afterAll(() => {
  fs.rmSync(h.dir, { recursive: true, force: true });
});

describe('a data-deleting Remove of a bot whose fleet database volume another instance declares', () => {
  it('refuses, keeping the volume and both records', async () => {
    writeRegistry(record('b1', { fleetDb }), record('b2', { fleetDb }));
    await expect(containerManager.deleteBot('b1', false, false)).rejects.toThrow(/hosts the fleet database in volume bot1-fleet-postgres-data/);
    expect(h.removed).not.toContain(DB);
    expect(h.volumes.has(DB)).toBe(true);
    expect(registered('b1')).toBe(true);
    expect(registered('b2')).toBe(true);
  });

  it('keeps it when the other instance holds it as its standby volume', async () => {
    writeRegistry(record('b1', { fleetDb }), record('b2', { fleetDbReplica: { ...fleetDbReplica, volume: DB } }));
    await expect(containerManager.deleteBot('b1', false, false)).rejects.toThrow(/hosts the fleet database/);
    expect(h.removed).not.toContain(DB);
  });

  it('keeps it when the other instance names it in its deployed compose', async () => {
    writeRegistry(record('b1', { fleetDb }), record('b2', { sanitizedName: 'bot2' }));
    deploy('b2', `services: {}\nvolumes:\n  fleet-postgres-data:\n    name: ${DB}\n`);
    await expect(containerManager.deleteBot('b1', false, false)).rejects.toThrow(/hosts the fleet database/);
    expect(h.removed).not.toContain(DB);
  });

  it('keeps it when another deployed compose cannot be read', async () => {
    writeRegistry(record('b1', { fleetDb }), record('b2', { sanitizedName: 'bot2' }));
    deploy('b2', 'services: [unclosed\n');
    await expect(containerManager.deleteBot('b1', false, false)).rejects.toThrow(/hosts the fleet database/);
    expect(h.removed).not.toContain(DB);
  });

  it('keeps it when the registry cannot be read at removal time', async () => {
    writeRegistry(record('b1', { fleetDb }));
    h.onComposeCleanup = () => fs.writeFileSync(registryPath, 'not json');
    await expect(containerManager.deleteBot('b1', false, false)).rejects.toThrow(/hosts the fleet database/);
    expect(h.removed).not.toContain(DB);
    expect(h.volumes.has(DB)).toBe(true);
  });

  it('a delete with keep data then completes and leaves the volume', async () => {
    writeRegistry(record('b1', { fleetDb }), record('b2', { fleetDb }));
    await expect(containerManager.deleteBot('b1', false, false)).rejects.toThrow(/hosts the fleet database/);
    await expect(containerManager.deleteBot('b1', true, false)).resolves.toBe(true);
    expect(registered('b1')).toBe(false);
    expect(h.volumes.has(DB)).toBe(true);
  });

  it('refuses a volume no other instance declares too', async () => {
    writeRegistry(record('b1', { fleetDb }), record('b2', { sanitizedName: 'bot2', fleetDb: { ...fleetDb, volume: 'bot2-fleet-postgres-data' } }));
    deploy('b2', 'services: {}\nvolumes:\n  data: {}\n');
    await expect(containerManager.deleteBot('b1', false, false)).rejects.toThrow(/Decommission it/);
    expect(h.removed).not.toContain(DB);
    expect(registered('b1')).toBe(true);
  });
});

describe('a data-deleting Remove of a bot whose standby replica volume another instance declares', () => {
  it('refuses, keeping the replica volume and the record', async () => {
    writeRegistry(record('b1', { fleetDbReplica }), record('b2', { fleetDbReplica }));
    await expect(containerManager.deleteBot('b1', false, false)).rejects.toThrow(/copy of the fleet database in volume bot1-fleet-postgres-replica-data/);
    expect(h.removed).not.toContain(REPLICA);
    expect(registered('b1')).toBe(true);
  });

  it('refuses a replica volume no other instance declares too', async () => {
    writeRegistry(record('b1', { fleetDbReplica }));
    await expect(containerManager.deleteBot('b1', false, false)).rejects.toThrow(/Remove the replica on the Database modal first/);
    expect(h.removed).not.toContain(REPLICA);
  });
});

describe('retiring a fleet database sidecar whose volume another instance declares', () => {
  it('refuses before removing anything and keeps the record', async () => {
    writeRegistry(record('b1', { fleetDb }), record('b2', { fleetDb }));
    const compose = `services:
  bot:
    image: x
  fleet-postgres:
    image: postgres:16
    container_name: bot1-fleet-postgres
    volumes:
      - fleet-postgres-data:/var/lib/postgresql/data
volumes:
  fleet-postgres-data:
    name: ${DB}
`;
    deploy('b1', compose);
    const res = await containerManager.retireFleetDbSidecar('b1');
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/database volume bot1-fleet-postgres-data kept: instance Bot b2 \(b2\) uses it/);
    expect(h.removed).not.toContain(DB);
    expect(containerManager.getBot('b1')?.fleetDb?.volume).toBe(DB);
    expect(h.containersRemoved.filter((c) => c.includes('"bot1-fleet-postgres"'))).toEqual([]);
    expect(fs.readFileSync(path.join(h.dir, 'bots', 'b1', 'docker-compose.yml'), 'utf-8')).toBe(compose);
  });

  it('still removes a volume no other instance declares', async () => {
    writeRegistry(record('b1', { fleetDb }));
    const res = await containerManager.retireFleetDbSidecar('b1');
    expect(res).toMatchObject({ success: true });
    expect(h.removed).toContain(DB);
    expect(containerManager.getBot('b1')?.fleetDb).toBeUndefined();
  });
});
