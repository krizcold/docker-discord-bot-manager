import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm3-l5-i-reg-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return { dir };
});

vi.mock('child_process', async (importOriginal) => (await import('./join-fake')).childProcessMock(await importOriginal<typeof import('child_process')>()));
vi.mock('../../src/casaos/detector', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/casaos/detector')>()),
  getDeploymentMode: async () => 'docker',
}));
vi.mock('../../src/webui/server', () => ({ broadcastToClients: () => {} }));

import * as fs from 'fs';
import * as path from 'path';
import * as YAML from 'yaml';
import * as containerManager from '../../src/docker/containerManager';
import * as envManager from '../../src/env/manager';
import { certSource } from '../../src/instance/fleetJoin';
import { docker, fakeJoinCode, fakeJoinRecord, FIXTURE_FP, FIXTURE_PEM, resetDocker } from './join-fake';

const SMDB = 'https://example.invalid/fake/super-modular-discord-bot';
const REGISTRY = path.join(h.dir, 'instances.json');
const TOKEN = 'Tok-Secret-7f3a9c2e51';
const base = (over: Record<string, unknown> = {}) => ({
  id: 'b', sanitizedName: 'b', displayName: 'B', titleName: 'B', status: 'stopped', sourceType: 'git', sourceUrl: SMDB,
  envVars: { DATA_BACKEND: 'postgres' }, createdAt: '2026-10-24T00:00:00.000Z', updatedAt: '2026-10-24T00:00:00.000Z', ...over,
});
const writeRegistry = (over: Record<string, unknown> = {}) =>
  fs.writeFileSync(REGISTRY, JSON.stringify({ instances: { b: base(over) } }));
const raw = () => fs.readFileSync(REGISTRY, 'utf-8');
const bot = () => containerManager.getBot('b')!;
const REPLICA = {
  containerName: 'b-fleet-postgres-replica', volume: 'b-fleet-postgres-replica-data', slot: 'fleet_standby_b',
  primaryHost: 'main.invalid', primaryPort: 15432, publicHost: 'copy.invalid', hostPort: 15433, certHost: 'copy.invalid',
  user: 'smdb', db: 'smdb', seededAt: 1,
};
const realFetch = certSource.fetch;
const BROKEN = /^The instance registry \(instances\.json\) cannot be read/;

beforeEach(() => {
  resetDocker();
  certSource.fetch = async () => ({ ok: true, pem: FIXTURE_PEM, fp: FIXTURE_FP });
  fs.rmSync(path.join(h.dir, 'bots'), { recursive: true, force: true });
  fs.mkdirSync(path.join(h.dir, 'bots', 'b', 'env'), { recursive: true });
  writeRegistry();
});
afterAll(() => {
  certSource.fetch = realFetch;
  fs.rmSync(h.dir, { recursive: true, force: true });
});

describe('a join record without a code', () => {
  it('reads with a blank code', () => {
    const rec = fakeJoinRecord();
    delete rec.code;
    writeRegistry({ fleetJoin: rec });
    expect(bot().fleetJoin!.code).toBe('');
  });

  it('is saved with a blank code', () => {
    const rec: any = fakeJoinRecord();
    delete rec.code;
    containerManager.updateInstanceFleetJoin('b', rec);
    expect(JSON.parse(raw()).instances.b.fleetJoin.code).toBe('');
  });
});

describe('each stored error alone is scrubbed on save', () => {
  const save = () => containerManager.updateInstanceFleetDbReplicaAndSeed('b', REPLICA as any, {} as any);

  it('a backup test result', () => {
    writeRegistry({ updateToken: TOKEN, fleetBackupTests: { postgres: { last: { at: 1, ok: false, text: `psql ${TOKEN} failed` } } } });
    save();
    expect(JSON.parse(raw()).instances.b.fleetBackupTests.postgres.last.text).toBe('psql *** failed');
  });

  it('a backup alert', () => {
    writeRegistry({ updateToken: TOKEN, fleetBackupAlerts: { 'postgres:dumps': { since: 1, text: `dump ${TOKEN}` } } });
    save();
    expect(JSON.parse(raw()).instances.b.fleetBackupAlerts['postgres:dumps'].text).toBe('dump ***');
  });

  it('a copy alert and its DM error', () => {
    writeRegistry({ updateToken: TOKEN, fleetCopyAlerts: { held: { since: 1, text: `held ${TOKEN}`, dmError: `dm ${TOKEN}` } } });
    save();
    expect(JSON.parse(raw()).instances.b.fleetCopyAlerts.held).toEqual({ since: 1, text: 'held ***', dmError: 'dm ***' });
  });

  it('the join\'s address error', () => {
    writeRegistry({ updateToken: TOKEN, fleetJoin: fakeJoinRecord({ addressesError: `read ${TOKEN}` }) });
    save();
    expect(JSON.parse(raw()).instances.b.fleetJoin.addressesError).toBe('read ***');
  });
});

describe('the record writers refuse a registry that does not read', () => {
  beforeEach(() => fs.writeFileSync(REGISTRY, '{ not json'));

  it('the standby and seed write', () => {
    expect(() => containerManager.updateInstanceFleetDbReplicaAndSeed('b', REPLICA as any, {} as any)).toThrow(BROKEN);
  });

  it('the join write', () => {
    expect(() => containerManager.updateInstanceFleetJoin('b', null)).toThrow(BROKEN);
  });

  it('the copy alert write', () => {
    expect(() => containerManager.updateInstanceFleetCopyAlert('b', 'held', null)).toThrow(BROKEN);
  });
});

describe('the record writers and a bot that is gone', () => {
  it('the standby and seed write names it', () => {
    expect(() => containerManager.updateInstanceFleetDbReplicaAndSeed('gone', REPLICA as any, {} as any)).toThrow('the bot is no longer in the registry');
  });

  it('the join write names it', () => {
    expect(() => containerManager.updateInstanceFleetJoin('gone', null)).toThrow('the bot is no longer in the registry');
  });

  it('the copy alert write does nothing', () => {
    const before = raw();
    expect(() => containerManager.updateInstanceFleetCopyAlert('gone', 'held', null)).not.toThrow();
    expect(raw()).toBe(before);
  });

  it('clearing an alert that is not there does not write', () => {
    const before = raw();
    containerManager.updateInstanceFleetCopyAlert('b', 'held', null);
    expect(raw()).toBe(before);
  });
});

describe('a join code kept only in the registry env', () => {
  it('is refused by mergedEnvVars', () => {
    writeRegistry({ envVars: { DATA_BACKEND: 'postgres', DATA_BACKEND_URL: fakeJoinCode() } });
    expect(() => containerManager.mergedEnvVars(bot())).toThrow('The Database URL of B holds a join code the manager has not checked yet.');
  });
});

describe('the standby service port follows the record on a compose sync', () => {
  const compose = path.join(h.dir, 'compose-i.yml');
  const sync = (replica: Record<string, unknown>) => {
    writeRegistry({ fleetDbReplica: { ...REPLICA, ...replica } });
    fs.writeFileSync(compose, 'services:\n  bot:\n    image: x\n  fleet-postgres-replica:\n    image: postgres:17\n    container_name: b-fleet-postgres-replica\n    ports:\n      - "1:5432"\n');
    expect(containerManager.syncComposeEnvVars(bot(), compose)).toBeNull();
    return YAML.parse(fs.readFileSync(compose, 'utf-8')).services['fleet-postgres-replica'].ports;
  };

  it('publishes the port when the record has a host and a port', () => {
    expect(sync({})).toEqual(['15433:5432']);
  });

  it('publishes nothing without a public host', () => {
    expect(sync({ publicHost: '' })).toBeUndefined();
  });

  it('publishes nothing without a port', () => {
    expect(sync({ hostPort: 0 })).toBeUndefined();
  });
});

describe('the fleet database is not minted for a joined bot', () => {
  it('a join record with a blank Database URL', () => {
    writeRegistry({ fleetJoin: fakeJoinRecord() });
    envManager.setEnvVars('b', { DATA_BACKEND_URL: '' });
    expect(containerManager.ensureFleetDataBackend(bot())).toBeNull();
    expect(bot().fleetDb).toBeUndefined();
  });
});

describe('a build whose stored join code cannot be used', () => {
  it('ends with a failure', async () => {
    envManager.setEnvVars('b', { DATA_BACKEND_URL: fakeJoinCode() });
    docker.main.inRecovery = true;
    const r = await containerManager.buildBot('b');
    expect(r).toEqual({ success: false, error: 'The join code in the Database URL could not be used: The database at main.invalid:15432 follows another database itself, so it cannot be joined; copy the join code from the manager of the machine that holds the main database.' });
  });
});

describe('a save with no stored error', () => {
  it('does not read the env store', () => {
    fs.writeFileSync(path.join(h.dir, 'bots', 'b', 'env', 'storage.json'), JSON.stringify({ vars: {}, encrypted: { K: 'old' } }));
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    containerManager.updateInstanceFleetDbReplica('b', REPLICA as any);
    const logged = err.mock.calls.flat().join(' ');
    err.mockRestore();
    expect(logged).not.toMatch(/\[EnvManager\]/);
  });
});
