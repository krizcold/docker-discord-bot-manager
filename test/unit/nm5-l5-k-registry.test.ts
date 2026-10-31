import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm5-l5-k-reg-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return { dir, execs: [] as Array<{ cmd: string; opts: any }>, execFail: null as Error | null };
});

vi.mock('child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('child_process')>();
  const base = (await import('./join-fake')).childProcessMock(real);
  const exec = (cmd: string, opts: any, cb?: any) => {
    const done = typeof opts === 'function' ? opts : cb;
    h.execs.push({ cmd, opts: typeof opts === 'function' ? undefined : opts });
    if (h.execFail) done?.(h.execFail);
    else done?.(null, { stdout: '', stderr: '' });
  };
  return { ...base, exec, default: { ...(base.default as object), exec } };
});
vi.mock('../../src/casaos/detector', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/casaos/detector')>()),
  getDeploymentMode: async () => 'docker',
}));
vi.mock('../../src/webui/server', () => ({ broadcastToClients: () => {} }));

import * as fs from 'fs';
import * as path from 'path';
import * as containerManager from '../../src/docker/containerManager';

const SMDB = 'https://example.invalid/fake/super-modular-discord-bot';
const REGISTRY = path.join(h.dir, 'instances.json');
const DEAD = 'v2:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const MAIN = { containerName: 'b-pg', user: 'smdb', db: 'smdb', volume: 'b-pgdata' };
const FORMER = { slot: 's', machine: 'old.invalid', host: 'old.invalid', port: 15432, generation: 3, at: '2026-10-28T00:00:00.000Z' };
const REPLICA = {
  containerName: 'b-fleet-postgres-replica', volume: 'b-fleet-postgres-replica-data', slot: 'fleet_standby_b',
  primaryHost: 'main.invalid', primaryPort: 15432, publicHost: 'copy.invalid', hostPort: 15433, certHost: 'copy.invalid',
  user: 'smdb', db: 'smdb', seededAt: 1,
};
const BROKEN = /^The instance registry \(instances\.json\) cannot be read/;
const base = (over: Record<string, unknown> = {}) => ({
  id: 'b', sanitizedName: 'b', displayName: 'B', titleName: 'B', status: 'stopped', sourceType: 'git', sourceUrl: SMDB,
  envVars: { DATA_BACKEND: 'postgres' }, createdAt: '2026-10-24T00:00:00.000Z', updatedAt: '2026-10-24T00:00:00.000Z', ...over,
});
const writeRegistry = (over: Record<string, unknown> = {}) => fs.writeFileSync(REGISTRY, JSON.stringify({ instances: { b: base(over) } }));
const stored = () => JSON.parse(fs.readFileSync(REGISTRY, 'utf-8')).instances.b;
const composeFile = () => path.join(h.dir, 'bots', 'b', 'docker-compose.yml');
const writeCompose = (body: string) => fs.writeFileSync(composeFile(), body);

beforeEach(() => {
  h.execs = [];
  h.execFail = null;
  fs.rmSync(path.join(h.dir, 'bots'), { recursive: true, force: true });
  fs.mkdirSync(path.join(h.dir, 'bots', 'b', 'env'), { recursive: true });
  writeRegistry();
});
afterAll(() => fs.rmSync(h.dir, { recursive: true, force: true }));

describe("the former main's join code", () => {
  it('a code that no longer decrypts reads blank, and its ciphertext survives a save', () => {
    writeRegistry({ fleetDb: { ...MAIN, formerMain: { ...FORMER, code: DEAD } } });
    expect(containerManager.getBot('b')!.fleetDb!.formerMain!.code).toBe('');
    containerManager.updateInstanceFleetDbSwitch('b', { pushBroken: null });
    expect(stored().fleetDb.formerMain.code).toBe(DEAD);
  });

  it('a record without a code reads blank', () => {
    writeRegistry({ fleetDb: { ...MAIN, formerMain: { ...FORMER } } });
    expect(containerManager.getBot('b')!.fleetDb!.formerMain!.code).toBe('');
  });

  it('a record without a code is saved blank', () => {
    writeRegistry({ fleetDb: { ...MAIN } });
    containerManager.updateInstanceFleetDbSwitch('b', { formerMain: { ...FORMER } as any });
    expect(stored().fleetDb.formerMain.code).toBe('');
  });
});

describe('the switch field writers', () => {
  const writers: Array<[string, () => void]> = [
    ['updateInstanceFleetDbSwitch', () => containerManager.updateInstanceFleetDbSwitch('b', { pushBroken: null })],
    ['updateInstanceAddressesPush', () => containerManager.updateInstanceAddressesPush('b', null)],
    ['updateInstanceFleetDbReplicaTakeover', () => containerManager.updateInstanceFleetDbReplicaTakeover('b', null)],
  ];
  it.each(writers)('%s refuses a registry that cannot be read', (_name, write) => {
    fs.writeFileSync(REGISTRY, '{ broken');
    expect(write).toThrow(BROKEN);
  });

  it('the switch writer names a bot without a main record', () => {
    expect(() => containerManager.updateInstanceFleetDbSwitch('b', { pushBroken: null })).toThrow(new Error('the bot holds no main database record any more'));
    expect(() => containerManager.updateInstanceFleetDbSwitch('gone', { pushBroken: null })).toThrow(new Error('the bot holds no main database record any more'));
  });
  it('the addresses writer names a bot that is gone', () => {
    expect(() => containerManager.updateInstanceAddressesPush('gone', null)).toThrow(new Error('the bot is not in the registry any more'));
  });
  it('the take-over writer names a bot without a copy record', () => {
    expect(() => containerManager.updateInstanceFleetDbReplicaTakeover('gone', null)).toThrow(new Error('the bot holds no live copy record any more'));
  });
});

describe('adopting the copy as the main', () => {
  it('without a new restore notice keeps the stored one', () => {
    const notice = { file: 'old.dump', text: 'Restore of old.dump failed: x', at: '2026-10-27T10:00:00.000Z', doubt: true };
    writeRegistry({ fleetDbReplica: { ...REPLICA }, fleetRestoreError: notice });
    expect(containerManager.adoptFleetDbReplicaAsPrimary('b').success).toBe(true);
    expect(stored().fleetRestoreError).toEqual(notice);
  });
});

describe('stopFleetDbSidecar', () => {
  const stopCmd = (service: string) => `docker compose -f "${composeFile()}" -p "b" stop ${service}`;
  beforeEach(() => writeRegistry({ fleetDb: { ...MAIN } }));

  it('stops the service whose container is the database, skipping others', async () => {
    writeCompose('services:\n  n: null\n  other:\n    container_name: zzz\n  db:\n    container_name: b-pg\n  later:\n    container_name: b-pg\n');
    expect(await containerManager.stopFleetDbSidecar('b')).toEqual({ success: true });
    expect(h.execs).toEqual([{ cmd: stopCmd('db'), opts: { timeout: 90_000 } }]);
  });

  it('a service key with other characters is not used', async () => {
    writeCompose('services:\n  "x y":\n    container_name: b-pg\n');
    expect(await containerManager.stopFleetDbSidecar('b')).toEqual({ success: true });
    expect(h.execs.map(e => e.cmd)).toEqual([stopCmd('fleet-postgres')]);
  });

  it('a compose that does not parse falls back to fleet-postgres', async () => {
    writeCompose('services: [\n');
    expect(await containerManager.stopFleetDbSidecar('b')).toEqual({ success: true });
    expect(h.execs.map(e => e.cmd)).toEqual([stopCmd('fleet-postgres')]);
  });

  it('a failed stop answers the error', async () => {
    writeCompose('services:\n  db:\n    container_name: b-pg\n');
    h.execFail = new Error('docker said no');
    expect(await containerManager.stopFleetDbSidecar('b')).toEqual({ success: false, error: 'Error: docker said no' });
  });

  it('refuses a bot without a database, and one never deployed', async () => {
    writeRegistry();
    expect(await containerManager.stopFleetDbSidecar('b')).toEqual({ success: false, error: 'This instance hosts no managed fleet database' });
    writeRegistry({ fleetDb: { ...MAIN } });
    expect(await containerManager.stopFleetDbSidecar('b')).toEqual({ success: false, error: 'Deployed compose not found' });
    expect(h.execs).toEqual([]);
  });
});
