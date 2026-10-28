import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

type Reply = { fail?: boolean; message?: string; stdout?: string; stderr?: string };

const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm3-l5-e-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return {
    dir,
    calls: [] as { cmd: string; args: string[]; opts: unknown }[],
    exec: (_args: string[]): Reply => ({ stdout: '' }),
    spawn: (_args: string[]): Reply => ({ stdout: '' }),
    dataDirFail: '',
    markFail: '',
    marks: [] as string[],
  };
});

vi.mock('child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('child_process')>();
  const { EventEmitter } = await import('events');
  const { PassThrough } = await import('stream');
  const execFile = (cmd: string, args: string[], optsOrCb: unknown, maybeCb?: unknown) => {
    const cb = (typeof optsOrCb === 'function' ? optsOrCb : maybeCb) as (err: Error | null, stdout: string, stderr: string) => void;
    h.calls.push({ cmd, args, opts: typeof optsOrCb === 'function' ? undefined : optsOrCb });
    const a = h.exec(args);
    setTimeout(() => cb(a.fail ? new Error(a.message ?? a.stderr ?? 'failed') : null, a.stdout ?? '', a.stderr ?? ''), 1);
    return new EventEmitter();
  };
  const spawn = (cmd: string, args: string[], opts: unknown) => {
    h.calls.push({ cmd, args, opts });
    const a = h.spawn(args);
    const c: any = new EventEmitter();
    c.stdout = new PassThrough();
    c.stderr = new PassThrough();
    c.kill = () => true;
    setTimeout(() => {
      c.stdout.end(a.stdout ?? '');
      c.stderr.end(a.stderr ?? '');
      setTimeout(() => c.emit('close', a.fail ? 1 : 0), 2);
    }, 2);
    return c;
  };
  return { ...real, execFile, spawn, default: { ...real, execFile, spawn } };
});
vi.mock('../../src/casaos/detector', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/casaos/detector')>()),
  getDeploymentMode: async () => 'docker',
}));
vi.mock('../../src/webui/server', () => ({ broadcastToClients: () => {} }));
vi.mock('../../src/instance/fleetReplica', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/instance/fleetReplica')>();
  return {
    ...real,
    instanceDataDir: async (instance: any) => {
      if (h.dataDirFail) throw new Error(h.dataDirFail);
      return real.instanceDataDir(instance);
    },
  };
});
vi.mock('../../src/docker/containerManager', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/docker/containerManager')>();
  return {
    ...real,
    markPendingApplyIfRunning: async (id: string) => {
      if (h.markFail) throw new Error(h.markFail);
      h.marks.push(id);
    },
  };
});

import * as fs from 'fs';
import * as path from 'path';
import * as containerManager from '../../src/docker/containerManager';
import * as envManager from '../../src/env/manager';
import * as dbLogin from '../../src/instance/dbLogin';
import {
  addressUpsertSql, computeEnvList, deleteAddress, readAddresses, readCopyFacts, registerAddress, writeCertFiles, writeEnvList,
} from '../../src/instance/fleetJoin';
import { COPY_FP, COPY_PEM, fakeJoin, fakeJoinRecord, FIXTURE_FP, FIXTURE_PEM } from './join-fake';

const SMDB = 'https://example.invalid/fake/super-modular-discord-bot';
const OTHER = 'https://example.invalid/fake/some-other-app';
const REGISTRY = path.join(h.dir, 'instances.json');
const base = (over: Record<string, unknown> = {}) => ({
  id: 'b', sanitizedName: 'b', displayName: 'B', titleName: 'B', status: 'running', sourceType: 'git', sourceUrl: SMDB,
  envVars: { DATA_BACKEND: 'postgres' }, createdAt: '2026-10-24T00:00:00.000Z', updatedAt: '2026-10-24T00:00:00.000Z',
  fleetJoin: fakeJoinRecord(), ...over,
});
const REPLICA = {
  containerName: 'b-fleet-postgres-replica', volume: 'b-fleet-postgres-replica-data', slot: 'fleet_standby_b',
  primaryHost: 'main.invalid', primaryPort: 15432, publicHost: 'copy.invalid', hostPort: 15433, certHost: 'copy.invalid',
  user: 'smdb', db: 'smdb', seededAt: 1,
};
const writeRegistry = (over: Record<string, unknown> = {}, more: Record<string, unknown> = {}) =>
  fs.writeFileSync(REGISTRY, JSON.stringify({ instances: { b: base(over), ...more } }, null, 2));
const bot = () => containerManager.getBot('b')!;
const code = fakeJoin();
const FP16 = FIXTURE_FP.slice(0, 16);
const COPY16 = COPY_FP.slice(0, 16);
const spawned = () => h.calls.filter(c => c.args[0] === 'run');
const nameOf = (args: string[]) => args[args.indexOf('--name') + 1];
const row = (over: Record<string, unknown> = {}) => ({ host: 'other.invalid', port: 15434, slot: 'fleet_standby_x', cert: COPY_PEM, machine: 'other', ...over });

beforeEach(() => {
  h.calls = [];
  h.exec = () => ({ stdout: '' });
  h.spawn = () => ({ stdout: '' });
  h.dataDirFail = '';
  h.markFail = '';
  h.marks = [];
  dbLogin.resetManagerRoleCache();
  fs.rmSync(path.join(h.dir, 'bots'), { recursive: true, force: true });
  fs.mkdirSync(path.join(h.dir, 'bots', 'b', 'env'), { recursive: true });
  writeRegistry();
});
afterAll(() => fs.rmSync(h.dir, { recursive: true, force: true }));

describe('readAddresses', () => {
  it('runs the read in a container named for the list', async () => {
    h.spawn = () => ({ stdout: '[]\n' });
    await readAddresses(bot(), code, FIXTURE_PEM);
    expect(spawned().map(c => nameOf(c.args))).toEqual(['b-fleet-join-list']);
  });

  it('reads an answer of only white space as an empty list', async () => {
    h.spawn = () => ({ stdout: '  \n' });
    expect(await readAddresses(bot(), code, FIXTURE_PEM)).toEqual({ ok: true, addresses: [] });
  });

  it('reads an empty answer as an empty list', async () => {
    h.spawn = () => ({ stdout: '' });
    expect(await readAddresses(bot(), code, FIXTURE_PEM)).toEqual({ ok: true, addresses: [] });
  });

  it('refuses an answer that is not a list', async () => {
    h.spawn = () => ({ stdout: '{}\n' });
    expect(await readAddresses(bot(), code, FIXTURE_PEM)).toEqual({ ok: false, reason: 'the list is not a list' });
  });

  it('refuses an answer that is not JSON', async () => {
    h.spawn = () => ({ stdout: 'oops\n' });
    expect(await readAddresses(bot(), code, FIXTURE_PEM)).toEqual({ ok: false, reason: 'the list could not be read' });
  });

  it('leaves out a malformed row and keeps a good one', async () => {
    h.spawn = () => ({ stdout: JSON.stringify([row({ host: 'bad host' }), row()]) });
    const r = await readAddresses(bot(), code, FIXTURE_PEM);
    expect(r).toEqual({ ok: true, addresses: [{ host: 'other.invalid', port: 15434, slot: 'fleet_standby_x', cert: COPY_PEM.trim(), machine: 'other' }] });
  });
});

describe('addressUpsertSql', () => {
  const good = { host: 'other.invalid', port: 15434, slot: null, cert: COPY_PEM, machine: 'other' };

  it('refuses a host that is not a bare hostname', () => {
    expect(() => addressUpsertSql({ ...good, host: 'bad host' })).toThrow(new Error('the host bad host is not a bare hostname or IPv4 address'));
  });

  it.each([1.5, 0, 65536])('refuses the port %s', port => {
    expect(() => addressUpsertSql({ ...good, port })).toThrow(new Error('the port is not a port number'));
  });

  it.each([1, 65535])('takes the port %s', port => {
    expect(addressUpsertSql({ ...good, port })).toContain(`, ${port}, NULL, `);
  });

  it('refuses a certificate that is not a PEM block', () => {
    expect(() => addressUpsertSql({ ...good, cert: 'not a cert' })).toThrow(new Error('the certificate is not a PEM certificate block'));
  });

  it('takes a certificate with white space around it and stores it trimmed', () => {
    const sql = addressUpsertSql({ ...good, cert: `  \n${COPY_PEM}  ` });
    expect(sql).toContain(`'${COPY_PEM.trim()}', 'other')`);
  });

  it('writes slot NULL for the main row', () => {
    expect(addressUpsertSql(good)).toContain(`VALUES ('other.invalid', 15434, NULL, '${COPY_PEM.trim()}', 'other')`);
  });
});

describe('registerAddress and deleteAddress', () => {
  it('runs the register in a container named for it', async () => {
    expect(await registerAddress(bot(), code, FIXTURE_PEM, { host: 'other.invalid', port: 15434, slot: null, cert: COPY_PEM, machine: 'o' })).toBeNull();
    expect(spawned().map(c => nameOf(c.args))).toEqual(['b-fleet-join-register']);
  });

  it('runs the delete in a container named for it', async () => {
    expect(await deleteAddress(bot(), code, FIXTURE_PEM, 'other.invalid', 15434)).toBeNull();
    expect(spawned().map(c => nameOf(c.args))).toEqual(['b-fleet-join-unregister']);
  });

  it('refuses to delete a host that is not a bare hostname, without running anything', async () => {
    expect(await deleteAddress(bot(), code, FIXTURE_PEM, 'bad host', 1)).toBe('the host bad host is not a bare hostname or IPv4 address');
    expect(spawned()).toEqual([]);
  });
});

describe('writeCertFiles', () => {
  const dir = () => path.join(h.dir, 'bots', 'b', 'data', 'db-certs');

  it('adds the final newline to a certificate without one', async () => {
    expect(await writeCertFiles(bot(), [COPY_PEM.trim()])).toBeNull();
    expect(fs.readFileSync(path.join(dir(), `${COPY16}.crt`), 'utf-8')).toBe(COPY_PEM);
  });

  it('keeps a certificate that already ends in a newline as it is', async () => {
    expect(await writeCertFiles(bot(), [COPY_PEM])).toBeNull();
    expect(fs.readFileSync(path.join(dir(), `${COPY16}.crt`), 'utf-8')).toBe(COPY_PEM);
  });

  it('names the data folder when the folder itself cannot be found', async () => {
    h.dataDirFail = 'no binds';
    expect(await writeCertFiles(bot(), [COPY_PEM])).toBe('The certificate files could not be written to the data folder (no binds); nothing else was changed.');
  });
});

describe('computeEnvList', () => {
  const url = (host: string, port: number, fp16: string, root = '/data') =>
    `postgresql://smdb:app%2Cpa%25ss@${host}:${port}/smdb?sslmode=verify-full&sslrootcert=${root}/db-certs/${fp16}.crt`;

  it('gives the main and others, read from the /data folder when the app names none', () => {
    writeRegistry({ sourceUrl: OTHER });
    expect(computeEnvList(bot())).toEqual([url('main.invalid', 15432, FP16)]);
  });

  it('gives nothing for the instance that holds the main itself', () => {
    writeRegistry({ fleetDb: { containerName: 'b-fleet-postgres' } });
    expect(computeEnvList(bot())).toBeNull();
  });

  it('leaves out a copy the operator cleared', () => {
    writeRegistry({ fleetDbReplica: { ...REPLICA, copyCleared: true } });
    expect(computeEnvList(bot())).toEqual([url('main.invalid', 15432, FP16)]);
  });

  it('leaves out a copy never seeded', () => {
    const { seededAt: _s, ...unseeded } = REPLICA;
    writeRegistry({ fleetDbReplica: unseeded });
    expect(computeEnvList(bot())).toEqual([url('main.invalid', 15432, FP16)]);
  });

  it('lists the copy first and drops an address that is the copy itself', () => {
    writeRegistry({ fleetDbReplica: REPLICA, fleetJoin: fakeJoinRecord({ addresses: [row({ host: 'copy.invalid', port: 15433 })] }) });
    const list = computeEnvList(bot())!;
    expect(list).toHaveLength(2);
    expect(list[0]).toContain('@b-fleet-postgres-replica:5432/');
    expect(list[1]).toBe(url('main.invalid', 15432, FP16));
  });

  it('reaches a main on this manager by its container', () => {
    writeRegistry({}, { m: base({ id: 'm', sanitizedName: 'm', fleetJoin: undefined, fleetDb: { containerName: 'm-fleet-postgres', replication: { publicHost: 'main.invalid', hostPort: 15432 } } }) });
    const list = computeEnvList(bot())!;
    expect(list).toHaveLength(1);
    expect(list[0]).toContain('@m-fleet-postgres:5432/');
  });
});

describe('writeEnvList', () => {
  const value = () => computeEnvList(bot())!.join(',');

  it('changes nothing for a bot the registry does not hold', async () => {
    expect(await writeEnvList('nope')).toEqual({ changed: false });
  });

  it('changes nothing for an app with no database URL key', async () => {
    writeRegistry({ sourceUrl: OTHER });
    expect(await writeEnvList('b')).toEqual({ changed: false });
  });

  it('writes the list and marks the bot', async () => {
    expect(await writeEnvList('b')).toEqual({ changed: true });
    expect(envManager.getEnvVars('b').DATA_BACKEND_URL).toBe(value());
    expect(h.marks).toEqual(['b']);
  });

  it('writes the list without a mark when asked not to', async () => {
    expect(await writeEnvList('b', { mark: false })).toEqual({ changed: true });
    expect(h.marks).toEqual([]);
  });

  it('changes nothing when the stored value differs only by white space', async () => {
    envManager.setEnvVars('b', { DATA_BACKEND_URL: ` ${value()} ` });
    expect(await writeEnvList('b')).toEqual({ changed: false });
    expect(h.marks).toEqual([]);
  });

  it('reports a mark that fails after the write', async () => {
    h.markFail = 'docker is gone';
    expect(await writeEnvList('b')).toEqual({ changed: true, markError: 'docker is gone' });
  });
});

describe('readCopyFacts', () => {
  const rec = { containerName: 'b-fleet-postgres-replica', user: 'smdb', db: 'smdb' };
  const facts = (out: string) => { h.exec = () => ({ stdout: out }); };

  it('refuses a record with no database identity', async () => {
    expect(await readCopyFacts({ containerName: 'c' })).toEqual({ ok: false, reason: 'its record has no database identity to read it with' });
  });

  it('reads the facts with one docker exec of psql as the manager role', async () => {
    facts('true|streaming|7001|1|0/4000000\n');
    const r = await readCopyFacts(rec);
    expect(r).toEqual({ ok: true, facts: { inRecovery: true, streaming: true, systemId: '7001', timeline: 1, lsn: 0x4000000n } });
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0].cmd).toBe('docker');
    expect(h.calls[0].args.slice(0, 8)).toEqual(['exec', 'b-fleet-postgres-replica', 'psql', '-U', 'dbm_admin', '-d', 'smdb', '-Atc']);
    expect(h.calls[0].opts).toEqual({ timeout: 120_000 });
  });

  it('reads leading white space and a main that is not in recovery', async () => {
    facts('  false||7001|12|0/4000000\n');
    expect(await readCopyFacts(rec)).toEqual({ ok: true, facts: { inRecovery: false, streaming: false, systemId: '7001', timeline: 12, lsn: 0x4000000n } });
  });

  it('creates the missing manager role from psql\'s stderr and reads again', async () => {
    let first = true;
    h.exec = args => {
      if (args.includes('-Atc')) {
        if (first) { first = false; return { fail: true, stderr: 'psql: error: FATAL:  role "dbm_admin" does not exist', message: 'Command failed' }; }
        return { stdout: 'true|streaming|7001|1|0/4000000\n' };
      }
      return { stdout: 'true\n' };
    };
    const r = await readCopyFacts(rec);
    expect(r.ok).toBe(true);
    expect(h.calls.filter(c => c.args.includes('-Atc'))).toHaveLength(2);
  });

  it('does not retry a failure that is not a missing role', async () => {
    h.exec = () => ({ fail: true, stderr: 'psql: error: connection refused' });
    expect(await readCopyFacts(rec)).toEqual({ ok: false, reason: "the copy's database did not answer" });
    expect(h.calls).toHaveLength(1);
  });

  it('refuses a failed read even when its stderr looks like an answer', async () => {
    h.exec = () => ({ fail: true, stderr: 'true|streaming|7001|1|0/4000000' });
    expect(await readCopyFacts(rec)).toEqual({ ok: false, reason: "the copy's database did not answer" });
  });

  it.each([
    'maybe|streaming|7001|1|0/4000000',
    'true|streaming|x7001|1|0/4000000',
    'true|streaming|7001x|1|0/4000000',
    'true|streaming|7001|x1|0/4000000',
    'true|streaming|7001|1x|0/4000000',
  ])('refuses the garbled answer %s', async out => {
    facts(`${out}\n`);
    expect(await readCopyFacts(rec)).toEqual({ ok: false, reason: "the copy's database did not answer" });
  });
});
