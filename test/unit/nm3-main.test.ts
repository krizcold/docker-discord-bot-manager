import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm3-main-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return {
    dir,
    sql: [] as string[],
    running: 'true' as string,
    cert: '' as string,
    fail: '' as string,
    slots: '' as string,
    addresses: '[]' as string,
  };
});

// A fake docker that records every statement psql gets (argument or stdin) and answers the few reads the lanes check.
vi.mock('child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('child_process')>();
  const { EventEmitter } = await import('events');
  const { PassThrough } = await import('stream');
  const nodeFs = await import('fs');
  const answer = (args: string[], stdin: string): { code: number; out: string; err: string } => {
    const text = `${args.join(' ')} ${stdin}`;
    if (h.fail && text.includes(h.fail)) return { code: 1, out: '', err: `ERROR:  ${h.fail} refused` };
    if (text.includes('cat /var/lib/postgresql/data/server.crt')) return h.cert ? { code: 0, out: h.cert, err: '' } : { code: 1, out: '', err: 'cat: no such file' };
    if (text.includes("WHERE line LIKE '%")) return { code: 0, out: '0\n', err: '' };
    if (text.includes('FROM pg_roles WHERE rolname')) return { code: 0, out: '1\n', err: '' };
    if (text.includes("current_setting('ssl')")) return { code: 0, out: `on||${h.slots}|4096MB\n`, err: '' };
    if (text.includes("to_regclass('smdb_manager.addresses') IS NULL")) return { code: 0, out: `${h.addresses}\n`, err: '' };
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
    child.stdin.on('finish', () => undefined);
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
import { decodeJoinCode } from '../../src/config/joinCode';
import { disableFleetReplication, dropFleetSlot, enableFleetReplication, getFleetReplicationStatus, getJoinCode } from '../../src/instance/fleetReplication';
import { FIXTURE_FP, FIXTURE_PEM } from './join-fake';

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
const stmtIndex = (needle: string) => h.sql.findIndex(s => s.includes(needle));

beforeEach(() => {
  h.sql = []; h.running = 'true'; h.cert = FIXTURE_PEM; h.fail = ''; h.slots = ''; h.addresses = '[]';
  fs.rmSync(path.join(h.dir, 'bots'), { recursive: true, force: true });
  fs.mkdirSync(path.join(h.dir, 'bots', 'm', 'env'), { recursive: true });
  writeRegistry({ fleetDb: { ...fleetDb, replication } });
  envManager.setEnvVars('m', { DATA_BACKEND_URL: dbUrl });
});
afterAll(() => fs.rmSync(h.dir, { recursive: true, force: true }));

describe('O1: the join code (C1 to C7)', () => {
  it('holds the address, the fingerprint and both logins', async () => {
    const r = await getJoinCode(bot());
    expect(r.success).toBe(true);
    const d = decodeJoinCode(r.joinCode!);
    expect(d).toEqual({ ok: true, code: {
      v: 1, host: 'main.invalid', port: 15432, db: 'smdb', fp: FIXTURE_FP, machine: 'main.invalid',
      repl: { user: 'replicator', password: 'Repl-Secret-0123456789' }, app: { user: 'smdb', password: 'Db-Secret,%x' },
    } });
  });

  it('C3: the same code every time while nothing changed', async () => {
    expect((await getJoinCode(bot())).joinCode).toBe((await getJoinCode(bot())).joinCode);
  });

  it.each([
    ['T-1 replication off', () => writeRegistry({ fleetDb }), 'Replication is not enabled, so there is no join code.'],
    ['T-2 an unfinished Disable', () => writeRegistry({ fleetDb: { ...fleetDb, replication: { ...replication, disablingSince: '2026-10-25T00:00:00.000Z' } } }), 'A Disable of replication did not finish, so the replication login may already be revoked: press Disable replication to finish it'],
    ['T-4 the database is stopped', () => { h.running = 'false'; }, 'The database container is not running, so its certificate cannot be read for the join code'],
    ['T-6 no app password', () => envManager.setEnvVars('m', { DATA_BACKEND_URL: '' }), "The bot's database password could not be read from the stored database URL, so no join code was made"],
  ])('C1, C4, C6: %s', async (_n, arrange, error) => {
    arrange();
    expect(await getJoinCode(bot())).toEqual({ success: false, error });
  });

  it('T-3: a password that no longer decrypts', async () => {
    writeRegistry({ fleetDb: { ...fleetDb, replication: { ...replication, password: '' } } });
    const r = await getJoinCode(bot());
    expect(r.error).toBe('The stored replication password no longer decrypts (the manager encryption key changed or was lost). Restore the key, or disable and re-enable replication to make a new one; every other machine then needs the new join code.');
  });

  it('C5 / T-5: an unreadable certificate names the reason', async () => {
    h.cert = '';
    expect((await getJoinCode(bot())).error).toMatch(/^The database's certificate could not be read, so no join code was made: /);
    h.cert = 'not a pem';
    expect((await getJoinCode(bot())).error).toMatch(/^The database's certificate could not be read, so no join code was made: /);
  });
});

describe('O2: Enable resets synchronous replication and writes the address list (C8 to C13)', () => {
  it('runs reset, then keep, hba and reload, then the address script with this main\'s row', async () => {
    const r = await enableFleetReplication(bot(), 'main.invalid', 15432);
    expect(r).toMatchObject({ success: true });
    const keep = stmtIndex('max_slot_wal_keep_size');
    const reset = stmtIndex('ALTER SYSTEM RESET synchronous_standby_names');
    const reload = stmtIndex('pg_reload_conf');
    const addresses = stmtIndex('CREATE SCHEMA IF NOT EXISTS smdb_manager');
    expect(keep).toBeGreaterThanOrEqual(0);
    expect(reset).toBeGreaterThan(keep);
    expect(reload).toBeGreaterThan(reset);
    expect(addresses).toBeGreaterThan(reload);
    const script = h.sql[addresses];
    expect(script).toContain('GRANT SELECT, INSERT, UPDATE, DELETE ON smdb_manager.addresses TO replicator');
    expect(script).toContain("VALUES ('main.invalid', 15432, NULL, '-----BEGIN CERTIFICATE-----");
    expect(script).not.toContain('DELETE FROM smdb_manager.addresses');
  });

  it('C13: a moved host or port deletes the old own row in the same script', async () => {
    await enableFleetReplication(bot(), 'new.invalid', 15440);
    const script = h.sql[stmtIndex('CREATE SCHEMA IF NOT EXISTS smdb_manager')];
    expect(script).toContain("DELETE FROM smdb_manager.addresses WHERE slot IS NULL AND host = 'main.invalid' AND port = 15432;");
    expect(script.indexOf('DELETE FROM')).toBeLessThan(script.indexOf('INSERT INTO'));
  });

  it('C8: a refused reset fails and leaves the record as it was', async () => {
    h.fail = 'RESET synchronous_standby_names';
    const before = JSON.stringify(bot().fleetDb);
    const r = await enableFleetReplication(bot(), 'new.invalid', 15440);
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/^resetting synchronous replication failed: /);
    expect(JSON.stringify(bot().fleetDb)).toBe(before);
  });

  it('C11: a refused address script fails and leaves the record unwritten', async () => {
    h.fail = 'CREATE SCHEMA IF NOT EXISTS smdb_manager';
    const before = JSON.stringify(bot().fleetDb);
    const r = await enableFleetReplication(bot(), 'new.invalid', 15440);
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/^setting up the address list failed: /);
    expect(r.error).not.toContain('Repl-Secret');
    expect(JSON.stringify(bot().fleetDb)).toBe(before);
  });
});

describe('Disable no longer refuses on a synchronous setting (C14)', () => {
  it('relaxes it and goes on to drop the slots', async () => {
    const r = await disableFleetReplication(bot());
    expect(r.success).toBe(true);
    expect(h.sql.some(s => s.includes("current_setting('synchronous_standby_names')"))).toBe(false);
    expect(stmtIndex('ALTER SYSTEM RESET synchronous_standby_names')).toBeLessThan(stmtIndex('pg_drop_replication_slot'));
  });
});

describe('the main\'s status and slot drop know the address list', () => {
  it('slots carry the machine and address of their copy', async () => {
    h.slots = JSON.stringify([{ slot: 'fleet_standby_abc', walStatus: 'lost', active: false, retainedBytes: 0 }, { slot: 'fleet_standby_def', walStatus: 'reserved', active: true }]);
    h.addresses = JSON.stringify([{ slot: 'fleet_standby_abc', machine: 'copy.invalid', host: 'copy.invalid', port: 15433 }]);
    const s = await getFleetReplicationStatus(bot(), { probeEndpoint: false });
    expect(s.live!.slots).toEqual([
      expect.objectContaining({ slot: 'fleet_standby_abc', machine: 'copy.invalid', address: 'copy.invalid:15433' }),
      expect.objectContaining({ slot: 'fleet_standby_def', machine: null, address: null }),
    ]);
  });

  it('dropFleetSlot deletes that slot\'s rows in the same statement', async () => {
    expect(await dropFleetSlot(bot(), 'fleet_standby_abc')).toEqual({ success: true });
    const drop = h.sql[stmtIndex("pg_drop_replication_slot('fleet_standby_abc')")];
    expect(drop).toContain("EXECUTE format('DELETE FROM smdb_manager.addresses WHERE slot = %L', 'fleet_standby_abc')");
  });
});
