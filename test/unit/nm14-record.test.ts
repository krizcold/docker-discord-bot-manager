import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm14-record-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return { dir, authid: '' as string, authidReads: 0 };
});

// docker inspect says running; the pg_authid read answers h.authid. No other docker command is answered with data.
vi.mock('child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('child_process')>();
  const { EventEmitter } = await import('events');
  const execFile = (_cmd: string, args: string[], opts: any, cb?: any) => {
    const done = typeof opts === 'function' ? opts : cb;
    setImmediate(() => {
      if (args[0] === 'inspect') return done(null, 'true\n', '');
      if (args.join(' ').includes('pg_authid')) { h.authidReads++; return done(null, `${h.authid}\n`, ''); }
      done(null, '', '');
    });
    return new EventEmitter();
  };
  return { ...real, execFile, default: { ...real, execFile } };
});
vi.mock('../../src/docker/dockerClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/docker/dockerClient')>()),
  volumeState: () => 'absent',
}));
vi.mock('../../src/casaos/detector', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/casaos/detector')>()),
  getDeploymentMode: async () => 'docker',
}));
vi.mock('../../src/webui/server', () => ({ broadcastToClients: () => {} }));

import * as fs from 'fs';
import * as path from 'path';
import * as containerManager from '../../src/docker/containerManager';
import * as envManager from '../../src/env/manager';
import { scramSha256Verifier } from '../../src/config/secretText';
import { managedDbPasswordFilled } from '../../src/instance/fleetReplication';

const SMDB = 'https://example.invalid/fake/super-modular-discord-bot';
const REGISTRY = path.join(h.dir, 'instances.json');
const SIDE = 'b-fleet-postgres';
const BAD_BLOB = `v2:${'0'.repeat(24)}:${'0'.repeat(32)}:abcdef`;
const writeRegistry = (over: Record<string, unknown> = {}) => fs.writeFileSync(REGISTRY, JSON.stringify({
  instances: {
    b: {
      id: 'b', sanitizedName: 'b', displayName: 'B', titleName: 'B', status: 'running', sourceType: 'git', sourceUrl: SMDB,
      envVars: { DATA_BACKEND: 'postgres' }, createdAt: '2026-10-24T00:00:00.000Z', updatedAt: '2026-10-24T00:00:00.000Z', ...over,
    },
  },
}));
const raw = () => JSON.parse(fs.readFileSync(REGISTRY, 'utf-8')).instances.b;
const bot = () => containerManager.getBot('b')!;
const fleetDb = { containerName: SIDE, user: 'smdb', db: 'smdb', volume: 'b-fleet-postgres-data' };
const errors: string[] = [];

beforeEach(() => {
  h.authid = ''; h.authidReads = 0;
  errors.length = 0;
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { errors.push(args.map(String).join(' ')); });
  vi.spyOn(console, 'log').mockImplementation(() => {});
  fs.rmSync(path.join(h.dir, 'bots'), { recursive: true, force: true });
  fs.mkdirSync(path.join(h.dir, 'bots', 'b', 'env'), { recursive: true });
  writeRegistry();
  envManager.setEnvVars('b', { DATA_BACKEND: 'postgres' });
});
afterEach(() => { vi.restoreAllMocks(); });
afterAll(() => { fs.rmSync(h.dir, { recursive: true, force: true }); });

describe('O6: the build lane stamps the minted password only', () => {
  it('C18: the mint records the password it wrote into the URL, encrypted at rest', () => {
    const made = containerManager.ensureFleetDataBackend(bot())!;
    const url = envManager.getEnvVars('b').DATA_BACKEND_URL;
    expect(decodeURIComponent(new URL(url).password)).toBe(made.password);
    expect(bot().fleetDb?.password).toBe(made.password);
    expect(raw().fleetDb.password).toMatch(/^v2:/);
    expect(fs.readFileSync(REGISTRY, 'utf-8')).not.toContain(made.password);
  });
  it('C21: later builds keep the record and never mint again', () => {
    const made = containerManager.ensureFleetDataBackend(bot())!;
    const again = containerManager.ensureFleetDataBackend(bot())!;
    expect(again.password).toBe(made.password);
    expect(bot().fleetDb?.password).toBe(made.password);
  });
  it.each([
    ['C22: a managed URL with a password', 'postgresql://smdb:Db-Pw-0123456789@b-fleet-postgres:5432/smdb'],
    ['C23: a managed URL without a password', 'postgresql://smdb@b-fleet-postgres:5432/smdb'],
  ])('%s and no record: the record is stamped without a password', (_n, url) => {
    envManager.setEnvVars('b', { DATA_BACKEND_URL: url });
    expect(containerManager.ensureFleetDataBackend(bot())).toMatchObject({ containerName: SIDE });
    expect(raw().fleetDb).toEqual(fleetDb);
  });
  it('V1-1 (was C24): a record with a password is never replaced by a build, whatever the URL holds', () => {
    writeRegistry({ fleetDb: { ...fleetDb, password: 'Kept-Pw-0123456789' } });
    envManager.setEnvVars('b', { DATA_BACKEND_URL: 'postgresql://smdb:Other-0123456789@b-fleet-postgres:5432/smdb' });
    containerManager.ensureFleetDataBackend(bot());
    expect(bot().fleetDb?.password).toBe('Kept-Pw-0123456789');
  });
  it('C20 and V1-12: a crash before the stamp; the rebuild stamps no password and the first fill records the minted one', async () => {
    const made = containerManager.ensureFleetDataBackend(bot())!;
    const reg = JSON.parse(fs.readFileSync(REGISTRY, 'utf-8'));
    delete reg.instances.b.fleetDb;
    fs.writeFileSync(REGISTRY, JSON.stringify(reg));
    containerManager.ensureFleetDataBackend(bot());
    expect(raw().fleetDb).toEqual(fleetDb);
    h.authid = `v|${scramSha256Verifier(made.password, Buffer.alloc(16, 3), 4096)}`;
    expect(await managedDbPasswordFilled(bot(), { record: true })).toEqual({ ok: true, password: made.password });
    expect(bot().fleetDb?.password).toBe(made.password);
    expect(h.authidReads).toBe(1);
  });
});

describe('O8: fleetDb.password at the registry boundary', () => {
  it('C31, C33: saved as v2 ciphertext, loaded as plaintext', () => {
    writeRegistry({ fleetDb: { ...fleetDb } });
    containerManager.updateInstanceFleetDbPassword('b', 'Plain-Pw-0123456789');
    expect(raw().fleetDb.password).toMatch(/^v2:/);
    expect(fs.readFileSync(REGISTRY, 'utf-8')).not.toContain('Plain-Pw-0123456789');
    expect(bot().fleetDb?.password).toBe('Plain-Pw-0123456789');
  });
  it('C32, C34: a ciphertext that does not decrypt reads as \'\', logs once, and every save keeps it', () => {
    writeRegistry({ fleetDb: { ...fleetDb, password: BAD_BLOB } });
    expect(bot().fleetDb?.password).toBe('');
    expect(errors).toContain('[ContainerManager] fleetDb.password for instance b no longer decrypts (encryption key changed or lost); its ciphertext stays preserved in the registry - restore the key');
    containerManager.updateInstanceFleetDbReplication('b', null, ['172.30.0.9']);
    expect(raw().fleetDb.password).toBe(BAD_BLOB);
    expect(raw().fleetDb.keptPlain).toEqual(['172.30.0.9']);
  });
  it('C35: a ciphertext that decrypts again heals at the next load', () => {
    writeRegistry({ fleetDb: { ...fleetDb, password: BAD_BLOB } });
    expect(bot().fleetDb?.password).toBe('');
    writeRegistry({ fleetDb: { ...fleetDb, password: envManager.encrypt('Healed-0123456789') } });
    expect(bot().fleetDb?.password).toBe('Healed-0123456789');
  });
  it('C36: the browser copy holds \'\'', () => {
    writeRegistry({ fleetDb: { ...fleetDb, password: 'Plain-Pw-0123456789' } });
    expect(containerManager.withoutRecordSecrets(bot())!.fleetDb?.password).toBe('');
    writeRegistry({ fleetDb: { ...fleetDb } });
    expect(containerManager.withoutRecordSecrets(bot())!.fleetDb).not.toHaveProperty('password');
  });
  it('C37: recordSecrets lists it, so stored errors are scrubbed of it', () => {
    writeRegistry({ fleetDb: { ...fleetDb, password: 'Plain-Pw-0123456789' } });
    expect(containerManager.recordSecrets(bot())).toContain('Plain-Pw-0123456789');
  });
  it('the adopt flip writes the given password with the record', () => {
    writeRegistry({ fleetDbReplica: { containerName: 'b-fleet-postgres-replica', volume: 'b-fleet-postgres-replica-data', slot: 'fleet_standby_b', primaryHost: 'p.invalid', primaryPort: 5433, user: 'smdb', db: 'smdb' } });
    expect(containerManager.adoptFleetDbReplicaAsPrimary('b', undefined, undefined, undefined, 'Adopt-Pw-0123456789')).toEqual({ success: true });
    expect(bot().fleetDb?.password).toBe('Adopt-Pw-0123456789');
    expect(raw().fleetDb.password).toMatch(/^v2:/);
  });
  it('the adopt flip without a password writes none', () => {
    writeRegistry({ fleetDbReplica: { containerName: 'b-fleet-postgres-replica', volume: 'b-fleet-postgres-replica-data', slot: 'fleet_standby_b', primaryHost: 'p.invalid', primaryPort: 5433, user: 'smdb', db: 'smdb' } });
    containerManager.adoptFleetDbReplicaAsPrimary('b');
    expect(raw().fleetDb).not.toHaveProperty('password');
  });
});
