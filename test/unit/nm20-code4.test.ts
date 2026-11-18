import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

// NM20 part 4: the switch, replica and join sites log in through part 1's builders (R3.3, S1), and the take-over caps
// as dbm_work before it raises as dbm_meta, with TK-RLS for a forced row-security policy (R3.6, Z4, Q3, P2).
const tmp = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm20-code4-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return { dir, exec: [] as string[][], answer: null as null | ((args: string[]) => { code: number; stdout: string; stderr: string } | null) };
});

// spawn goes to switch-fake (the psql scripts on stdin); execFile is recorded and answered by tmp.answer.
vi.mock('child_process', async (o) => {
  const real = await o<typeof import('child_process')>();
  const { switchSpawn } = await import('./switch-fake');
  const spawn = (cmd: string, args: string[], opts?: any) => switchSpawn(cmd, args, opts);
  const execFile = (_cmd: string, args: string[], optsOrCb: unknown, maybeCb?: unknown) => {
    const cb = (typeof optsOrCb === 'function' ? optsOrCb : maybeCb) as (e: Error | null, o: string, s: string) => void;
    tmp.exec.push(args);
    const a = tmp.answer?.(args) ?? { code: 0, stdout: '', stderr: '' };
    setTimeout(() => cb?.(a.code === 0 ? null : Object.assign(new Error('Command failed'), { code: a.code }), a.stdout, a.stderr), 0);
    return { on: () => undefined } as any;
  };
  const exec = (_cmd: string, opts: any, cb?: any) => {
    const done = typeof opts === 'function' ? opts : cb;
    done?.(null, { stdout: '', stderr: '' });
  };
  return { ...real, spawn, execFile, exec, default: { ...real, spawn, execFile, exec } };
});
vi.mock('../../src/instance/dbLogin', async (o) => (await import('./switch-harness')).dbLoginMock(await o()));
vi.mock('../../src/instance/maintenance', async (o) => (await import('./switch-harness')).maintenanceMock(await o()));
vi.mock('../../src/docker/containerManager', async (o) => (await import('./switch-harness')).containerManagerMock(await o()));
vi.mock('../../src/instance/fleetBackup', async (o) => (await import('./switch-harness')).fleetBackupMock(await o()));
vi.mock('../../src/instance/fleetJoin', async (o) => (await import('./switch-harness')).fleetJoinMock(await o()));
vi.mock('../../src/instance/fleetReplica', async (o) => (await import('./switch-harness')).fleetReplicaMock(await o()));
vi.mock('../../src/instance/appHookClient', async (o) => (await import('./switch-harness')).appHookMock(await o()));
vi.mock('../../src/instance/backupCheck', async (o) => (await import('./switch-harness')).backupCheckMock(await o()));
vi.mock('../../src/env/manager', async (o) => (await import('./switch-harness')).envMock(await o()));
vi.mock('../../src/config/appCapabilities', async (o) => (await import('./switch-harness')).capsMock(await o()));

import * as fs from 'fs';
import * as fleetSwitch from '../../src/instance/fleetSwitch';
import { handOver, readGeneration, readRestoreState, resetSwitchState, SWITCH_TIMING, switchTick, takeOverMain } from '../../src/instance/fleetSwitch';
import * as dbLogin from '../../src/instance/dbLogin';
import * as fleetReplica from '../../src/instance/fleetReplica';
import * as switchSql from '../../src/instance/switchSql';
import { parseAddressRows } from '../../src/instance/fleetJoin';
import { COPY_PEM, fake, freshDb, h, mainFixture, copyFixture, resetHarness, seedDbs, stored, writeRegistry } from './switch-harness';

const CAP: string = switchSql.SHARD_CAP_DO_SQL;
const PIN = `PGOPTIONS=${dbLogin.MANAGER_SESSION_OPTIONS}`;
const loginOf = (c: { args: string[] }) => c.args[c.args.indexOf('-U') + 1];
const dbOf = (c: { args: string[] }) => c.args[c.args.indexOf('-d') + 1];
const psqlCalls = () => fake.calls.filter(c => c.args[0] === 'exec' && c.args.includes('psql') && !c.args.includes('-h'));
const callsWith = (part: string) => psqlCalls().filter(c => c.input.includes(part));
const caps = () => psqlCalls().filter(c => c.input.includes('UPDATE smdb_data.shard_claims'));
const raises = () => psqlCalls().filter(c => c.input.includes('INSERT INTO smdb_manager.generation AS g'));
const ADMIN = (c: string) => ['exec', '-i', c, 'psql', '-X', '-U', 'dbm_admin', '-d', 'postgres', '-tA', '-v', 'ON_ERROR_STOP=1', '-q'];
const PLAIN = (login: string, c: string, db: string) => ['exec', '-e', PIN, '-i', c, 'psql', '-X', '-U', login, '-d', db, '-tA', '-v', 'ON_ERROR_STOP=1', '-q'];
const markRow = (dbOid: string, pushIds = ['a1']) => { fake.dbs['c-pg'].receiveMark = { markId: pushIds[0], pushIds, dbOid }; };
const quiet = () => {
  const spies = (['warn', 'log', 'error'] as const).map(l => vi.spyOn(console, l).mockImplementation(() => undefined));
  return () => spies.forEach(s => s.mockRestore());
};

/** Every psql login of the manager: dbm_admin only on postgres, a plain login only in the bot's database with the pins. */
const loginsHold = () => {
  for (const c of psqlCalls()) {
    const login = loginOf(c);
    if (login === 'dbm_admin') expect(c.args.slice(0, 11), c.input.slice(0, 80)).toEqual(ADMIN(c.args[2]).slice(0, 11));
    else {
      expect(['dbm_meta', 'dbm_work'], c.input.slice(0, 80)).toContain(login);
      expect(c.args.slice(0, 3)).toEqual(['exec', '-e', PIN]);
      expect(dbOf(c)).toBe('app');
    }
  }
};

beforeEach(() => {
  resetHarness();
  resetSwitchState();
  tmp.exec.length = 0;
  tmp.answer = null;
  SWITCH_TIMING.replayWaitMs = 50;
  SWITCH_TIMING.catchUpMs = 60;
  SWITCH_TIMING.pollMs = 5;
});
afterAll(() => fs.rmSync(tmp.dir, { recursive: true, force: true }));

describe('NM20 part 4: the take-over caps as dbm_work, then raises as dbm_meta (R3.6, decide1 G3)', () => {
  beforeEach(() => {
    fake.dbs['c-pg'] = freshDb({ recovery: true, handover: null, addresses: [
      { host: 'main.invalid', port: 15432, slot: null, machine: 'main.invalid', cert: COPY_PEM },
      { host: 'copy.example', port: 5434, slot: 'slot_c', machine: 'copy.example', cert: COPY_PEM },
    ], copies: [{ slot: 'slot_c', machine: 'copy.example', client: '10.0.0.2' }] });
    writeRegistry({ c: copyFixture() });
    markRow('11111');
  });
  const press = async (opts: Record<string, unknown> = { confirmUnchecked: true, start: false }) => {
    const done = quiet();
    try { return await takeOverMain('c', opts as any); } finally { done(); }
  };
  const TK_RLS = (t: string) => `The copy is promoted, but its shard claims could not be capped: row-level security is forced on smdb_data.${t}, so Take over fails the same way until it is lifted. The generation was not raised, so bots may not choose this copy over the old main, and the bot's login to it stays blocked. The manager has no SQL console; on this machine, run docker exec -it c-pg psql -U dbm_work -d app -c 'SET ROLE "app"; ALTER TABLE smdb_data.${t} NO FORCE ROW LEVEL SECURITY'. Then press Take over again.`;
  const RLS_ERR = (t: string) => `psql:<stdin>:1: ERROR:  query would be affected by row-level security policy for table "${t}"`;
  const CONTEXT = 'CONTEXT:  SQL statement "UPDATE smdb_data.shard_claims AS t SET expires_up_ms = LEAST(t.expires_up_ms, k.up_ms) FROM smdb_data.claim_clock AS k WHERE k.id = 1"\nPL/pgSQL function inline_code_block line 3 at EXECUTE';

  it('the cap is its own dbm_work call in the bot database, before a dbm_meta raise that holds no cap', async () => {
    const r = await press();
    expect(r.success).toBe(true);
    expect(caps()).toHaveLength(1);
    expect(caps()[0].args).toEqual(PLAIN('dbm_work', 'c-pg', 'app'));
    expect(caps()[0].input).toBe(CAP);
    expect(raises()).toHaveLength(1);
    expect(raises()[0].args).toEqual(PLAIN('dbm_meta', 'c-pg', 'app'));
    expect(raises()[0].input).not.toContain('smdb_data');
    expect(raises()[0].input).toContain("IF to_regclass('smdb_manager.addresses') IS NOT NULL THEN");
    expect(fake.calls.indexOf(caps()[0])).toBeLessThan(fake.calls.indexOf(raises()[0]));
    expect(h.events.indexOf('raise')).toBeLessThan(h.events.indexOf('hba-lift'));
  });

  it('a take-over with no unchecked mark sends no cap', async () => {
    fake.dbs['c-pg'].receiveMark = null;
    const r = await press({ confirm: true, start: false });
    expect(r.success).toBe(true);
    expect(caps()).toEqual([]);
    expect(raises()).toHaveLength(1);
  });

  it('T1: the cap commits and the raise fails: the existing text; the next press caps again and raises', async () => {
    fake.dbs['c-pg'].fail.raise = 'ERROR:  disk full';
    const r1 = await press();
    expect(r1.text).toBe('The copy is promoted, but its generation could not be raised (ERROR:  disk full), so bots may not choose it over the old main. Press Take over again to finish.');
    expect(caps()).toHaveLength(1);
    expect(h.events).not.toContain('hba-lift');
    expect(stored('c').fleetDbReplica.takeover).toMatchObject({ unchecked: true });
    delete fake.dbs['c-pg'].fail.raise;
    h.copyFacts = { ok: true, facts: { inRecovery: false, streaming: false, systemId: '7001', timeline: 2, lsn: 1n } };
    fake.calls.length = 0;
    const r2 = await press({ start: false });
    expect(r2.success).toBe(true);
    expect(caps()).toHaveLength(1);
    expect(raises()).toHaveLength(1);
    expect(fake.calls.indexOf(caps()[0])).toBeLessThan(fake.calls.indexOf(raises()[0]));
  });

  it.each([
    ['the refusal as the last line', `${RLS_ERR('shard_claims')}\n`, 'shard_claims'],
    ['the refusal followed by CONTEXT lines', `${RLS_ERR('shard_claims')}\n${CONTEXT}\n`, 'shard_claims'],
    ['the joined clock table, followed by CONTEXT lines', `${RLS_ERR('claim_clock')}\n${CONTEXT}\n`, 'claim_clock'],
  ])('TK-RLS: %s', async (_n, stderr, table) => {
    fake.dbs['c-pg'].fail.cap = stderr;
    const r = await press();
    expect(r.success).toBe(false);
    expect(r.text).toBe(TK_RLS(table));
    expect(raises()).toEqual([]);
    expect(h.events).not.toContain('hba-lift');
    expect(stored('c').fleetDbReplica.takeover).toMatchObject({ unchecked: true });
  });

  it('a cap failure without the refusal keeps the existing text with its error line, and raises nothing', async () => {
    fake.dbs['c-pg'].fail.cap = `psql:<stdin>:1: ERROR:  permission denied for table shard_claims\n${CONTEXT}\n`;
    const r = await press();
    expect(r.text).toBe('The copy is promoted, but its generation could not be raised (psql:<stdin>:1: ERROR:  permission denied for table shard_claims), so bots may not choose it over the old main. Press Take over again to finish.');
    expect(raises()).toEqual([]);
    expect(h.events).not.toContain('hba-lift');
  });

  it('the TK-RLS text is built from the stderr alone, and null without the refusal', () => {
    const copy = { container: 'c-pg', db: 'app', user: 'app' };
    expect(fleetSwitch.rowSecurityRefusal(`${RLS_ERR('shard_claims')}\n${CONTEXT}\n`, copy)).toBe(TK_RLS('shard_claims'));
    expect(fleetSwitch.rowSecurityRefusal('psql:<stdin>:1: ERROR:  disk full\n', copy)).toBeNull();
  });

  it('every login of a take-over is dbm_admin on postgres or a pinned plain login in the bot database', async () => {
    await press();
    expect(psqlCalls().length).toBeGreaterThan(5);
    loginsHold();
    for (const part of ['FROM pg_database WHERE datname', 'pg_last_xact_replay_timestamp()', "FROM smdb_manager.receive_mark), '')", 'oid::text FROM pg_database', 'pg_promote(', "current_setting('hba_file')", 'pg_reload_conf()']) {
      for (const c of callsWith(part)) expect(loginOf(c), part).toBe('dbm_admin');
    }
    for (const part of ["FROM smdb_manager.generation), '0||')", "FROM smdb_manager.handover), '')", 'FROM smdb_manager.copies WHERE slot <>']) {
      expect(callsWith(part).length, part).toBeGreaterThan(0);
      for (const c of callsWith(part)) expect(loginOf(c), part).toBe('dbm_meta');
    }
  });

  it("the received rows of a replaced database are read as dbm_meta, the mark and the oid as dbm_admin (S1)", async () => {
    fake.dbs['c-pg'].received.push({ pushId: 'a1', from: '9', machine: 'win.local', generation: 3 });
    await press({ confirm: true, start: false });
    expect(callsWith('FROM smdb_manager.received WHERE push_id IN (').map(loginOf)).toEqual(['dbm_meta']);
    expect(callsWith("FROM smdb_manager.receive_mark), '')").map(c => c.args.slice(0, 7))).toEqual([ADMIN('c-pg').slice(0, 7)]);
  });
});

describe('NM20 part 4: S1, the cluster-level smdb_manager tables run as dbm_admin on postgres', () => {
  beforeEach(() => {
    fake.dbs['a-pg'] = freshDb();
    writeRegistry({ a: mainFixture() });
  });

  it("readRestoreState's read", async () => {
    fake.dbs['a-pg'].restoreState = { pending: true, file: 'r.dump', at: 'x', generation: 3, machine: 'm', since: null };
    expect((await readRestoreState({ container: 'a-pg', user: 'app' })).ok).toBe(true);
    expect(callsWith('FROM smdb_manager.restore_state')[0].args).toEqual(ADMIN('a-pg'));
  });

  it("the tick's restore clear, and the stale mark's read and clear", async () => {
    fake.dbs['a-pg'].restoreState = { pending: true, file: 'r.dump', at: 'x', generation: 3, machine: 'm', since: null };
    fake.dbs['a-pg'].receiveMark = { markId: 'a1', pushIds: ['a1'], dbOid: '16384' };
    const done = quiet();
    await switchTick(Date.now() + 3_600_000);
    done();
    for (const part of ['UPDATE smdb_manager.restore_state SET pending = false', "FROM smdb_manager.receive_mark), '')", 'DELETE FROM smdb_manager.receive_mark']) {
      expect(callsWith(part).length, part).toBeGreaterThan(0);
      for (const c of callsWith(part)) expect(c.args, part).toEqual(ADMIN('a-pg'));
    }
    expect(fake.dbs['a-pg'].receiveMark).toBeNull();
    loginsHold();
  });

  it('a failed dbm_meta call drops the container from the confirmed set; a failed dbm_admin call does not', async () => {
    const fault = vi.spyOn(dbLogin, 'noteLoginFault');
    try {
      fake.dbs['a-pg'].fail['restore-read'] = 'ERROR:  boom';
      expect((await readRestoreState({ container: 'a-pg', user: 'app' })).ok).toBe(false);
      expect(fault).not.toHaveBeenCalled();
      fake.dbs['a-pg'].fail['gen-read'] = 'ERROR:  boom';
      expect((await readGeneration({ container: 'a-pg', user: 'app' }, 'app')).ok).toBe(false);
      expect(fault).toHaveBeenCalledWith('a-pg');
    } finally {
      fault.mockRestore();
    }
  });
});

describe('NM20 part 4: the hand-over reads the slot as dbm_admin and its address as dbm_meta (decide1 G1, G2: sw:594 split)', () => {
  beforeEach(() => {
    seedDbs();
    writeRegistry({ a: mainFixture() });
  });

  it('the slot read names no smdb_manager table and runs on postgres; the address half and the row run as dbm_meta', async () => {
    const done = quiet();
    const r = await handOver('a', 'slot_c', false);
    done();
    expect(r.success).toBe(true);
    expect(stored('a').fleetDb.handover).toMatchObject({ machine: 'copy.example', host: 'copy.example', port: 5434 });
    const slotReads = callsWith('FROM pg_replication_slots s LEFT JOIN pg_stat_replication r');
    expect(slotReads.length).toBeGreaterThan(0);
    for (const c of slotReads) {
      expect(c.args).toEqual(ADMIN('a-pg'));
      expect(c.input).not.toContain('smdb_manager');
    }
    const address = callsWith("SELECT coalesce((SELECT 'addr|'");
    expect(address).toHaveLength(1);
    expect(address[0].args).toEqual(PLAIN('dbm_meta', 'a-pg', 'app'));
    expect(callsWith('INSERT INTO smdb_manager.handover').map(c => c.args)).toEqual([PLAIN('dbm_meta', 'a-pg', 'app')]);
    loginsHold();
  });

  it("a failed slot read refuses before the address is read", async () => {
    fake.dbs['a-pg'].fail['slot-read'] = 'ERROR:  boom';
    const done = quiet();
    const r = await handOver('a', 'slot_c', false);
    done();
    expect(r.success).toBe(false);
    expect(r.text).toBe("The manager could not read this database's copies (ERROR:  boom); nothing was changed");
    expect(callsWith("SELECT coalesce((SELECT 'addr|'")).toEqual([]);
  });

  it("a failed address read refuses with its error", async () => {
    fake.dbs['a-pg'].fail['address-read'] = 'ERROR:  permission denied for table addresses';
    const done = quiet();
    const r = await handOver('a', 'slot_c', false);
    done();
    expect(r.text).toBe("The manager could not read this database's copies (ERROR:  permission denied for table addresses); nothing was changed");
  });
});

describe("NM20 part 4: the tick's logins on a main with copies", () => {
  it('pg_control_system as dbm_admin; the copies list, the peers and the streaming list as dbm_meta', async () => {
    seedDbs();
    writeRegistry({ a: mainFixture() });
    const done = quiet();
    await switchTick(Date.now() + 3_600_000);
    await fleetSwitch.streamingCopies(stored('a'));
    done();
    expect(callsWith('pg_control_system()').map(loginOf)).toEqual(['dbm_admin']);
    for (const part of ['INSERT INTO smdb_manager.copies AS c', "FROM smdb_manager.addresses a\nWHERE a.slot ~ '^fleet_standby_[0-9a-f]{32}$'", "s.slot_type = 'physical'"]) {
      expect(callsWith(part).length, part).toBeGreaterThan(0);
      for (const c of callsWith(part)) expect(loginOf(c), part).toBe('dbm_meta');
    }
    loginsHold();
  });
});

describe('NM20 part 4: fleetJoin readCopyFacts and validAddress', () => {
  const rec = { containerName: 'b-fleet-postgres-replica', user: 'smdb', db: 'smdb' };
  const join = () => vi.importActual<typeof import('../../src/instance/fleetJoin')>('../../src/instance/fleetJoin');

  it('reads the facts with one docker exec of psql as dbm_admin on postgres', async () => {
    tmp.answer = () => ({ code: 0, stdout: 'true|streaming|7001|1|0/4000000\n', stderr: '' });
    const r = await (await join()).readCopyFacts(rec);
    expect(r).toEqual({ ok: true, facts: { inRecovery: true, streaming: true, systemId: '7001', timeline: 1, lsn: 0x4000000n } });
    expect(tmp.exec).toHaveLength(1);
    expect(tmp.exec[0].slice(0, 11)).toEqual(['exec', rec.containerName, 'psql', '-X', '-U', 'dbm_admin', '-d', 'postgres', '-tA', '-v', 'ON_ERROR_STOP=1']);
    expect(tmp.exec[0][11]).toBe('-c');
    expect(tmp.exec[0][12]).toContain('pg_control_checkpoint()');
  });

  it('a missing dbm_admin is one failed read: no check, no role made, no login as the bot role', async () => {
    tmp.answer = () => ({ code: 2, stdout: '', stderr: 'psql: error: FATAL:  role "dbm_admin" does not exist' });
    expect(await (await join()).readCopyFacts(rec)).toEqual({ ok: false, reason: "the copy's database did not answer" });
    expect(tmp.exec).toHaveLength(1);
  });

  it('validAddress is exported and answers as parseAddressRows reads one row', async () => {
    const { validAddress } = await join();
    const row = { host: 'copy.example', port: 5434, slot: 'slot_c', cert: `${COPY_PEM}\n`, machine: 'copy.example' };
    expect(validAddress(row)).toEqual(parseAddressRows(JSON.stringify([row]))[0]);
    expect(validAddress({ ...row, port: 0 })).toBeNull();
    expect(validAddress(null)).toBeNull();
    const check: switchSql.AddressCheck = validAddress;
    expect(check(row)).toEqual(validAddress(row));
  });
});

describe("NM20 part 4: fleetReplica's probes run as dbm_admin on postgres", () => {
  const copy = { containerName: 'bot1-fleet-postgres-replica', user: 'smdb', db: 'smdb', volume: 'v', publicHost: 'standby.invalid', hostPort: 5440, primaryHost: 'primary.invalid', primaryPort: 5433 };

  it("getFleetReplicaStatus's probe, and a missing dbm_admin is one failed probe", async () => {
    tmp.answer = args => (args.some(a => a.includes('pg_stat_wal_receiver')) ? { code: 2, stdout: '', stderr: 'psql: error: FATAL:  role "dbm_admin" does not exist' } : null);
    await fleetReplica.getFleetReplicaStatus({ id: 'b1', fleetDbReplica: copy } as any);
    const probes = tmp.exec.filter(a => a.some(x => x.includes('pg_stat_wal_receiver')));
    expect(probes).toHaveLength(1);
    expect(probes[0].slice(0, 12)).toEqual(['exec', copy.containerName, 'psql', '-X', '-U', 'dbm_admin', '-d', 'postgres', '-tA', '-v', 'ON_ERROR_STOP=1', '-c']);
    expect(tmp.exec.filter(a => a.includes('psql') && a[a.indexOf('-U') + 1] !== 'dbm_admin')).toEqual([]);
  });
});
