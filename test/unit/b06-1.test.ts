import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'b06-1-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  process.env.RECOVERY_RELAY_IMAGE = 'fake/manager:1';
  return {
    dir,
    calls: [] as Array<{ cmd: string; args: string[]; env: Record<string, string | undefined>; stdin: string }>,
    // A run whose argv or stdin matches fails with this stderr (the text of
    // the run itself appended, as Postgres does with its STATEMENT line).
    failWhen: null as null | RegExp,
    failStderr: '',
  };
});

// A fake docker and openssl. Every run is recorded with its argv, its
// environment and what was written to its stdin; containers run, volumes are
// absent, and the primary probe answers "not in recovery".
vi.mock('child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('child_process')>();
  const { EventEmitter } = await import('events');
  const { PassThrough } = await import('stream');
  const nodeFs = await import('fs');
  const record = (cmd: string, args: string[], opts: any) => {
    const call = { cmd, args, env: (opts && opts.env) || {}, stdin: '' };
    h.calls.push(call);
    return call;
  };
  const failing = (call: { args: string[]; stdin: string }) => !!h.failWhen && h.failWhen.test(`${call.args.join(' ')}\n${call.stdin}`);
  const answer = (args: string[]): string => {
    if (args[0] === 'inspect' && args.some(a => a.includes('Networks'))) return 'smdb-net\n';
    if (args[0] === 'inspect') return 'true\n';
    if (args.includes('SELECT pg_is_in_recovery()')) return 'f\n';
    return '';
  };
  const execFile = (cmd: string, args: string[], opts: any, cb?: any) => {
    const done = typeof opts === 'function' ? opts : cb;
    const call = record(cmd, args, typeof opts === 'function' ? {} : opts);
    const child: any = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdin.on('data', (d: Buffer) => { call.stdin += d.toString(); });
    child.kill = () => {};
    setTimeout(() => {
      if (cmd === 'openssl') {
        // A real matching pair behind the markers: the install checks the key against the certificate.
        nodeFs.writeFileSync(args[args.indexOf('-keyout') + 1], 'FAKE-TLS-KEY-PEM-0123456789\n-----BEGIN PRIVATE KEY-----\nMIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgtM9o4pDpv0Cozikt\n4uwMJM46EUEJfbQjdtA2ByXUiKmhRANCAASCO4i47sdvseuYxeVB4O0rlxjNcVMU\n+oDBbAmwCX/c8cCbXLEKcl+wkz1IYT34cczAPZABg6O0Az0dRZ6eF3hp\n-----END PRIVATE KEY-----\n');
        nodeFs.writeFileSync(args[args.indexOf('-out') + 1], 'FAKE-TLS-CERT-PEM\n-----BEGIN CERTIFICATE-----\nMIIBmTCCAT6gAwIBAgIUDgY+bMG7vClw3xqVXtdber+h0UswCgYIKoZIzj0EAwIw\nFTETMBEGA1UEAwwKcmVsYXkudGVzdDAgFw0yNjEwMjQxOTU2NTNaGA8yMTI2MDkz\nMDE5NTY1M1owFTETMBEGA1UEAwwKcmVsYXkudGVzdDBZMBMGByqGSM49AgEGCCqG\nSM49AwEHA0IABII7iLjux2+x65jF5UHg7SuXGM1xUxT6gMFsCbAJf9zxwJtcsQpy\nX7CTPUhhPfhxzMA9kAGDo7QDPR1Fnp4XeGmjajBoMB0GA1UdDgQWBBQqYKbJkFWh\nxPOcT7Q49mMc8zDPvjAfBgNVHSMEGDAWgBQqYKbJkFWhxPOcT7Q49mMc8zDPvjAP\nBgNVHRMBAf8EBTADAQH/MBUGA1UdEQQOMAyCCnJlbGF5LnRlc3QwCgYIKoZIzj0E\nAwIDSQAwRgIhAPguVl9lDTbwuZR4c91bTG90pN57G5fKrqNVJt6cb1HKAiEA/AUV\nrXUvU3u3dD9I72F/lLjbLGmWaqohTGadeXPYkCk=\n-----END CERTIFICATE-----\n');
        return done(null, '', '');
      }
      if (args[0] === 'volume' && args[1] === 'inspect') return done(new Error('fail'), '', 'Error: No such volume');
      if (failing(call)) {
        return done(Object.assign(new Error(`Command failed: ${cmd} ${args.join(' ')}\n`), { code: 1 }), '', h.failStderr ? `${h.failStderr}\n${args.join(' ')}\n${call.stdin}` : '');
      }
      done(null, answer(args), '');
    }, 2);
    return child;
  };
  const exec = (_cmd: string, opts: any, cb?: any) => {
    const done = typeof opts === 'function' ? opts : cb;
    done(null, { stdout: '', stderr: '' });
  };
  const spawn = (cmd: string, args: string[], opts?: any) => {
    const call = record(cmd, args, opts);
    const child: any = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.stdin.on('data', (d: Buffer) => { call.stdin += d.toString(); });
    child.kill = () => {};
    setTimeout(() => {
      const fail = failing(call);
      child.stdout.end(fail ? '' : args.join(' ').includes('pg_read_file') ? '0\n' : answer(args));
      child.stderr.end(fail ? `${h.failStderr}\n${args.join(' ')}\n${call.stdin}` : '');
      setTimeout(() => child.emit('close', fail ? 1 : 0), 1);
    }, 5);
    return child;
  };
  const execFileSync = (cmd: string, args: string[], opts: any) => {
    if (cmd === 'docker' && args[0] === 'volume' && args[1] === 'inspect' && args[args.length - 1].endsWith('-fleet-postgres-replica-data')) throw new Error('Error: No such volume');
    return real.execFileSync(cmd, args, opts);
  };
  const fencedExecFile = (await import('./fence-fake')).withFence(execFile as any);
  const heldSpawn = (await import('./dump-fake')).withDumpHolder(spawn as any);
  return { ...real, execFile: fencedExecFile, execFileSync, exec, spawn: heldSpawn, default: { ...real, execFile: fencedExecFile, execFileSync, exec, spawn: heldSpawn } };
});
vi.mock('../../src/docker/containerManager', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/docker/containerManager')>()),
  runningNonSidecarContainers: async () => [],
  startFleetDbSidecar: async () => ({ success: true }),
  retireFleetDbSidecar: async () => ({ success: true }),
  deployedComposeExists: () => true,
  applyFleetDbReplicaService: async () => ({ success: false, error: 'fake apply failure' }),
  startBot: async () => ({ success: true }),
}));
vi.mock('../../src/instance/fleetBackupGuards', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/instance/fleetBackupGuards')>()),
  claimFleetBackupBusy: () => true,
  releaseFleetBackupBusy: () => {},
}));
vi.mock('../../src/instance/fleetBackup', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/instance/fleetBackup')>()),
  clearTermFloor: () => {},
  runFleetDump: async () => ({ success: true, file: 'fake.dump' }),
}));
vi.mock('../../src/instance/appHookClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/instance/appHookClient')>()),
  capabilityRefusal: () => null,
}));
vi.mock('../../src/casaos/detector', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/casaos/detector')>()),
  getDeploymentMode: async () => 'docker',
}));

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as containerManager from '../../src/docker/containerManager';
import * as envManager from '../../src/env/manager';
import { enableFleetReplication, getFleetReplicationStatus } from '../../src/instance/fleetReplication';
import { getFleetReplicaStatus, reseedStalePrimary } from '../../src/instance/fleetReplica';
import { scramSha256Verifier } from '../../src/config/secretText';
import { certSource } from '../../src/instance/fleetJoin';
import { codeFor, fixtureCert } from './join-fake';

beforeEach(() => { certSource.fetch = fixtureCert; });

const botDir = path.join(h.dir, 'bots', 'b1');
const DB_SECRET = 'Db-Secret-0123456789';
const REPL_SECRET = 'Repl-Secret-0123456789';
const dbUrl = `postgresql://smdb:${DB_SECRET}@bot1-fleet-postgres:5432/smdb?sslmode=no-verify`;
const fleetDb = { containerName: 'bot1-fleet-postgres', user: 'smdb', db: 'smdb', volume: 'bot1-fleet-postgres-data' };
const replication = { role: 'replicator', password: REPL_SECRET, hostPort: 15432, publicHost: 'primary.invalid', certHost: 'primary.invalid', slotWalKeepMb: 4096 };

const writeRegistry = (extra: Record<string, unknown> = {}): void => {
  fs.writeFileSync(path.join(h.dir, 'instances.json'), JSON.stringify({
    instances: {
      b1: {
        id: 'b1', sanitizedName: 'bot1', displayName: 'Bot 1', titleName: 'Bot 1', status: 'stopped',
        sourceType: 'git', sourceUrl: 'https://example.invalid/fake/super-modular-discord-bot',
        envVars: { DATA_BACKEND: 'postgres' },
        fleetDb,
        createdAt: '2026-10-24T00:00:00.000Z', updatedAt: '2026-10-24T00:00:00.000Z',
        ...extra,
      },
    },
  }));
};

const argvWith = (secret: string) => h.calls.filter(c => c.args.join(' ').includes(secret));
const waitFor = async (cond: () => boolean): Promise<void> => {
  for (let i = 0; i < 400 && !cond(); i++) await new Promise(r => setTimeout(r, 10));
};

beforeEach(() => {
  fs.rmSync(path.join(h.dir, 'bots'), { recursive: true, force: true });
  fs.mkdirSync(path.join(botDir, 'env'), { recursive: true });
  writeRegistry();
  envManager.setEnvVars('b1', { DATA_BACKEND: 'postgres', DATA_BACKEND_URL: dbUrl });
  h.calls.length = 0;
  h.failWhen = null;
  h.failStderr = '';
});

afterAll(() => {
  fs.rmSync(h.dir, { recursive: true, force: true });
});

describe('the SCRAM verifier', () => {
  it('matches the RFC 7677 example exchange', () => {
    const salt = Buffer.from('W22ZaJ0SNY7soEsUEjb6gQ==', 'base64');
    const verifier = scramSha256Verifier('pencil', salt, 4096);
    const m = /^SCRAM-SHA-256\$4096:([^$]+)\$([^:]+):(.+)$/.exec(verifier)!;
    expect(m[1]).toBe('W22ZaJ0SNY7soEsUEjb6gQ==');
    const serverKey = Buffer.from(m[3], 'base64');
    const authMessage = 'n=user,r=rOprNGfwEbeRWgbNEkqO,'
      + 'r=rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0,s=W22ZaJ0SNY7soEsUEjb6gQ==,i=4096,'
      + 'c=biws,r=rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0';
    const serverSignature = crypto.createHmac('sha256', serverKey).update(authMessage).digest('base64');
    expect(serverSignature).toBe('6rriTRBi23WpRR/wtup+mMhUZUn/dB5nLTJRsjl95G4=');
  });

  it('refuses a password outside ASCII rather than set one that never verifies', () => {
    expect(() => scramSha256Verifier('pässword')).toThrow(/ASCII/);
  });
});

describe('enabling replication', () => {
  it('sets the replicator password as a verifier on stdin, never in argv or as plain text', async () => {
    const res = await enableFleetReplication(containerManager.getBot('b1')!, 'primary.invalid', 15432);
    expect(res.success).toBe(true);
    const password = containerManager.getBot('b1')!.fleetDb!.replication!.password;
    expect(password.length).toBeGreaterThan(10);
    expect(argvWith(password)).toEqual([]);
    expect(h.calls.filter(c => c.stdin.includes(password))).toEqual([]);
    const role = h.calls.filter(c => /ROLE replicator/.test(c.stdin));
    expect(role.length).toBe(1);
    expect(role[0].stdin).toMatch(/SET log_min_error_statement = panic;/);
    expect(role[0].stdin).toMatch(/PASSWORD 'SCRAM-SHA-256\$4096:/);
    expect(role[0].stdin).not.toMatch(/DO \$\$/);
    expect(h.calls.filter(c => /ROLE replicator/.test(c.args.join(' ')))).toEqual([]);
  });

  it('reports a failed role statement without the password or its verifier', async () => {
    writeRegistry({ fleetDb: { ...fleetDb, replication } });
    h.failWhen = /ROLE replicator/;
    h.failStderr = 'ERROR:  fake failure\nSTATEMENT:';
    const res = await enableFleetReplication(containerManager.getBot('b1')!, 'primary.invalid', 15432);
    expect(res.success).toBe(false);
    expect(res.error).toContain('fake failure');
    expect(res.error).not.toContain(REPL_SECRET);
    expect(res.error).not.toMatch(/SCRAM-SHA-256\$/);
  });
});

describe('the endpoint reachability probe', () => {
  it('passes the database password by environment and reports a failure without the command line', async () => {
    writeRegistry({ fleetDb: { ...fleetDb, replication } });
    h.failWhen = /SELECT 1/;
    const status = await getFleetReplicationStatus(containerManager.getBot('b1')!);
    const probe = h.calls.filter(c => c.args.includes('SELECT 1'));
    expect(probe.length).toBe(1);
    expect(argvWith(DB_SECRET)).toEqual([]);
    expect(probe[0].args).toContain('PGPASSWORD');
    expect(probe[0].env.PGPASSWORD).toBe(DB_SECRET);
    expect(status.reachability?.ok).toBe(false);
    expect(status.reachability?.error || '').not.toContain(DB_SECRET);
    expect(status.reachability?.error || '').not.toMatch(/Command failed/);
  });
});

describe('seeding a standby', () => {
  it('gives psql and pg_basebackup the password by environment, never in argv', async () => {
    const pem = '-----BEGIN CERTIFICATE-----\nZmFrZQ==\n-----END CERTIFICATE-----';
    const started = reseedStalePrimary(containerManager.getBot('b1')!, codeFor(`postgresql://replicator:${REPL_SECRET}@primary.invalid:5433/smdb`), 'standby.invalid', 5440, true, { dumpDone: true });
    expect(started).toMatchObject({ success: true });
    await waitFor(() => containerManager.getBot('b1')?.fleetDbReplicaSeed?.parked === true);
    expect(containerManager.getBot('b1')?.fleetDbReplicaSeed?.parked).toBe(true);
    expect(argvWith(REPL_SECRET)).toEqual([]);
    const clients = h.calls.filter(c => c.args[0] === 'run' && (c.args.includes('psql') || c.args.includes('pg_basebackup')));
    expect(clients.some(c => c.args.includes('pg_basebackup'))).toBe(true);
    expect(clients.length).toBeGreaterThanOrEqual(3);
    for (const c of clients) {
      expect(c.args).toContain('PGPASSWORD');
      expect(c.env.PGPASSWORD).toBe(REPL_SECRET);
    }
  });

  it('B14-2Lb: strips the primary\'s fence lines from the copied pg_hba.conf with its inherited settings', async () => {
    const pem = '-----BEGIN CERTIFICATE-----\nZmFrZQ==\n-----END CERTIFICATE-----';
    reseedStalePrimary(containerManager.getBot('b1')!, codeFor(`postgresql://replicator:${REPL_SECRET}@primary.invalid:5433/smdb`), 'standby.invalid', 5440, true, { dumpDone: true });
    await waitFor(() => containerManager.getBot('b1')?.fleetDbReplicaSeed?.parked === true);
    const seed = h.calls.findIndex(c => c.args.includes('pg_basebackup'));
    const strip = h.calls.findIndex(c => c.args[0] === 'run' && c.args[c.args.length - 1].includes('/^synchronous_standby_names/d'));
    expect(seed).toBeGreaterThanOrEqual(0);
    expect(strip).toBeGreaterThan(seed);
    const { FENCED_HBA, MANAGED_HBA, runOnDataDir } = await import('./fence-fake');
    const ran = await runOnDataDir(h.calls[strip].args[h.calls[strip].args.length - 1], '/var/lib/postgresql/data', {
      'pg_hba.conf': FENCED_HBA + MANAGED_HBA,
      'postgresql.auto.conf': "synchronous_standby_names = 'x'\ndefault_transaction_read_only = 'on'\nwal_log_hints = 'on'\n",
    });
    expect(ran.files['pg_hba.conf']).toBe(MANAGED_HBA);
    expect(ran.files['postgresql.auto.conf']).toBe("wal_log_hints = 'on'\n");
    expect(ran.chowns).toEqual(['postgres:postgres /var/lib/postgresql/data/pg_hba.conf']);
  });
});

describe('stored error texts', () => {
  it('never keep a record secret on disk', () => {
    writeRegistry({ fleetDb: { ...fleetDb, replication } });
    const now = Date.now();
    containerManager.updateInstanceFleetDbReplicaSeed('b1', {
      purpose: 'provision', phase: 'seeding', startedAt: now, updatedAt: now, publicHost: 'h', hostPort: 5440,
      primaryHost: 'p', primaryPort: 5433, slot: 's', parked: true, lastError: `psql: could not log in with ${REPL_SECRET}`,
    });
    const disk = fs.readFileSync(path.join(h.dir, 'instances.json'), 'utf8');
    expect(disk).not.toContain(REPL_SECRET);
    const bot = containerManager.getBot('b1')!;
    expect(bot.fleetDbReplicaSeed?.lastError).toContain('***');
  });
});

describe('the status of a parked seed', () => {
  it('shows the stored error as it was saved', async () => {
    const now = Date.now();
    containerManager.updateInstanceFleetDbReplicaSeed('b1', {
      purpose: 'provision', phase: 'seeding', startedAt: now, updatedAt: now, publicHost: 'h', hostPort: 5440,
      primaryHost: 'p', primaryPort: 5433, slot: 's', parked: true, lastError: 'pg_basebackup failed: connection refused',
    });
    const status = await getFleetReplicaStatus(containerManager.getBot('b1')!);
    expect(status.parkedSeed?.lastError).toBe('pg_basebackup failed: connection refused');
  });
});
