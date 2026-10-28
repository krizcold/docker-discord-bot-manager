import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm3-l5-i-main-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return {
    dir,
    sql: [] as string[],
    running: 'true' as string,
    cert: '' as string,
    fail: '' as string,
    failErr: '' as string,
    slots: '' as string,
    addresses: '[]' as string,
    listFail: false,
  };
});

// The fake docker of nm3-main.test.ts, with a settable failure text and an address read that can fail with output.
vi.mock('child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('child_process')>();
  const { EventEmitter } = await import('events');
  const { PassThrough } = await import('stream');
  const nodeFs = await import('fs');
  const answer = (args: string[], stdin: string): { code: number; out: string; err: string } => {
    const text = `${args.join(' ')} ${stdin}`;
    if (h.fail && text.includes(h.fail)) return { code: 1, out: '', err: h.failErr || `ERROR:  ${h.fail} refused` };
    if (text.includes('cat /var/lib/postgresql/data/server.crt')) return h.cert ? { code: 0, out: h.cert, err: '' } : { code: 1, out: '', err: 'cat: no such file' };
    if (text.includes("WHERE line LIKE '%")) return { code: 0, out: '0\n', err: '' };
    if (text.includes('FROM pg_roles WHERE rolname')) return { code: 0, out: '1\n', err: '' };
    if (text.includes("current_setting('ssl')")) return { code: 0, out: `on||${h.slots}|4096MB\n`, err: '' };
    if (text.includes("to_regclass('smdb_manager.addresses') IS NULL")) return { code: h.listFail ? 1 : 0, out: `${h.addresses}\n`, err: h.listFail ? 'ERROR:  x' : '' };
    return { code: 0, out: '', err: '' };
  };
  const { FIXTURE_KEY, FIXTURE_PEM } = await import('./join-fake');
  const execFile = (cmd: string, args: string[], opts: any, cb?: any) => {
    const done = typeof opts === 'function' ? opts : cb;
    if (cmd === 'openssl') {
      nodeFs.writeFileSync(args[args.indexOf('-keyout') + 1], FIXTURE_KEY);
      nodeFs.writeFileSync(args[args.indexOf('-out') + 1], FIXTURE_PEM);
      setImmediate(() => done(null, '', ''));
    } else if (args[0] === 'inspect') setImmediate(() => done(null, `${h.running}\n`, ''));
    else {
      const a = answer(args, '');
      if (args.includes('psql')) h.sql.push(args.join(' '));
      setImmediate(() => done(a.code ? Object.assign(new Error(a.err), { code: a.code }) : null, a.out, a.err));
    }
    return new EventEmitter();
  };
  const spawn = (_cmd: string, args: string[]) => {
    const child: any = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.kill = () => true;
    let stdin = '';
    child.stdin.on('data', (d: Buffer) => { stdin += d; });
    setTimeout(() => {
      const a = answer(args, stdin);
      if (args.includes('psql')) h.sql.push(`${args.join(' ')}${stdin ? ` <<< ${stdin}` : ''}`);
      child.stdout.end(a.out);
      child.stderr.end(a.err);
      setTimeout(() => child.emit('close', a.code), 1);
    }, 5);
    return child;
  };
  return { ...real, execFile, spawn, default: { ...real, execFile, spawn } };
});
vi.mock('../../src/webui/server', () => ({ broadcastToClients: () => {} }));

import * as fs from 'fs';
import * as path from 'path';
import * as containerManager from '../../src/docker/containerManager';
import * as envManager from '../../src/env/manager';
import { addressTableSql, enableFleetReplication, getFleetReplicationStatus, getJoinCode } from '../../src/instance/fleetReplication';
import { FIXTURE_PEM } from './join-fake';

const dbUrl = 'postgresql://smdb:Db-Secret,%25x@m-fleet-postgres:5432/smdb?sslmode=no-verify';
const fleetDb = { containerName: 'm-fleet-postgres', user: 'smdb', db: 'smdb', volume: 'm-fleet-postgres-data' };
const replication = { role: 'replicator', password: 'Repl-Secret-0123456789', hostPort: 15432, publicHost: 'main.invalid', certHost: 'main.invalid', slotWalKeepMb: 4096 };
const writeRegistry = (extra: Record<string, unknown> = {}): void => {
  fs.writeFileSync(path.join(h.dir, 'instances.json'), JSON.stringify({ instances: { m: {
    id: 'm', sanitizedName: 'm', displayName: 'M', titleName: 'M', status: 'running', sourceType: 'git',
    sourceUrl: 'https://example.invalid/fake/super-modular-discord-bot', envVars: { DATA_BACKEND: 'postgres' },
    createdAt: '2026-10-24T00:00:00.000Z', updatedAt: '2026-10-24T00:00:00.000Z', ...extra,
  } } }));
};
const bot = () => containerManager.getBot('m')!;
const addressScript = () => h.sql.find(s => s.includes('CREATE SCHEMA IF NOT EXISTS smdb_manager'))!;

beforeEach(() => {
  h.sql = []; h.running = 'true'; h.cert = FIXTURE_PEM; h.fail = ''; h.failErr = ''; h.slots = ''; h.addresses = '[]'; h.listFail = false;
  fs.rmSync(path.join(h.dir, 'bots'), { recursive: true, force: true });
  fs.mkdirSync(path.join(h.dir, 'bots', 'm', 'env'), { recursive: true });
  writeRegistry({ fleetDb: { ...fleetDb, replication } });
  envManager.setEnvVars('m', { DATA_BACKEND_URL: dbUrl });
});
afterAll(() => fs.rmSync(h.dir, { recursive: true, force: true }));

describe('Enable: the failure texts', () => {
  it('a refused reset quotes the trimmed error', async () => {
    h.fail = 'RESET synchronous_standby_names';
    h.failErr = '  ERROR:  reset refused  \n';
    expect((await enableFleetReplication(bot(), 'main.invalid', 15432)).error).toBe('resetting synchronous replication failed: ERROR:  reset refused');
  });

  it('an unreadable certificate stops before the address list', async () => {
    h.cert = '';
    const r = await enableFleetReplication(bot(), 'main.invalid', 15432);
    expect(r).toMatchObject({ success: false, error: 'setting up the address list failed: the server certificate could not be read (cat: no such file)' });
    expect(addressScript()).toBeUndefined();
  });

  it('a refused address script quotes the trimmed error without the password', async () => {
    h.fail = 'CREATE SCHEMA IF NOT EXISTS smdb_manager';
    h.failErr = '  ERROR:  denied near Repl-Secret-0123456789  \n';
    expect((await enableFleetReplication(bot(), 'main.invalid', 15432)).error).toBe('setting up the address list failed: ERROR:  denied near ***');
  });
});

describe('Enable: the address script', () => {
  it('holds the certificate without its trailing newline', async () => {
    await enableFleetReplication(bot(), 'main.invalid', 15432);
    expect(addressScript()).toContain("-----END CERTIFICATE-----', 'main.invalid')");
  });

  it('a moved port alone deletes the old own row', async () => {
    await enableFleetReplication(bot(), 'main.invalid', 15440);
    expect(addressScript()).toContain("DELETE FROM smdb_manager.addresses WHERE slot IS NULL AND host = 'main.invalid' AND port = 15432;");
  });

  it('a moved host alone deletes the old own row', async () => {
    await enableFleetReplication(bot(), 'new.invalid', 15432);
    expect(addressScript()).toContain("DELETE FROM smdb_manager.addresses WHERE slot IS NULL AND host = 'main.invalid' AND port = 15432;");
  });

  it('with nothing moved the grants lead straight to the insert', () => {
    expect(addressTableSql('main.invalid', 15432, 'pem', 'main.invalid', null)).toContain('ON smdb_manager.addresses TO replicator;\nINSERT INTO smdb_manager.addresses');
  });
});

describe('the main\'s status and the address list', () => {
  it('a failed address read names no machine', async () => {
    h.slots = JSON.stringify([{ slot: 'fleet_standby_abc', walStatus: 'reserved', active: true }]);
    h.addresses = JSON.stringify([{ slot: 'fleet_standby_abc', machine: 'copy.invalid', host: 'copy.invalid', port: 15433 }]);
    h.listFail = true;
    const s = await getFleetReplicationStatus(bot(), { probeEndpoint: false });
    expect(s.live!.slots).toEqual([expect.objectContaining({ slot: 'fleet_standby_abc', machine: null, address: null })]);
  });

  it('a slot with no row does not stop a later slot getting its row', async () => {
    h.slots = JSON.stringify([{ slot: 'fleet_standby_def', walStatus: 'reserved', active: true }, { slot: 'fleet_standby_abc', walStatus: 'reserved', active: true }]);
    h.addresses = JSON.stringify([{ slot: 'fleet_standby_abc', machine: 'copy.invalid', host: 'copy.invalid', port: 15433 }]);
    const s = await getFleetReplicationStatus(bot(), { probeEndpoint: false });
    expect(s.live!.slots).toEqual([
      expect.objectContaining({ slot: 'fleet_standby_def', machine: null, address: null }),
      expect.objectContaining({ slot: 'fleet_standby_abc', machine: 'copy.invalid', address: 'copy.invalid:15433' }),
    ]);
  });

  it('a row without a machine name gives a blank name', async () => {
    h.slots = JSON.stringify([{ slot: 'fleet_standby_abc', walStatus: 'reserved', active: true }]);
    h.addresses = JSON.stringify([{ slot: 'fleet_standby_abc', host: 'copy.invalid', port: 15433 }]);
    const s = await getFleetReplicationStatus(bot(), { probeEndpoint: false });
    expect(s.live!.slots).toEqual([expect.objectContaining({ machine: '', address: 'copy.invalid:15433' })]);
  });
});

describe('the join code refusals are failures', () => {
  it('a password that no longer decrypts', async () => {
    writeRegistry({ fleetDb: { ...fleetDb, replication: { ...replication, password: '' } } });
    expect((await getJoinCode(bot())).success).toBe(false);
  });

  it('a certificate that cannot be read', async () => {
    h.cert = '';
    expect(await getJoinCode(bot())).toEqual({ success: false, error: "The database's certificate could not be read, so no join code was made: cat: no such file" });
  });

  it('a certificate that does not parse', async () => {
    h.cert = 'not a pem';
    expect((await getJoinCode(bot())).success).toBe(false);
  });
});
