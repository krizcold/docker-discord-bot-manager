import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Section 5's O7 X1, X5, X7 and X9 at their call sites (code review 1, finding 6); X7's mint and X8 are in
// nm3-stale.test.ts, which runs the real stale-primary re-seed.
const tmp = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm22-moves-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return { dir };
});

vi.mock('child_process', async (o) => (await import('./switch-harness')).childProcessMock(await o()));
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
import * as path from 'path';
import { decodeJoinCode, encodeMoveCode } from '../../src/config/joinCode';
import { push } from '../../src/instance/fleetMove';
import { handOver, SWITCH_TIMING, takeOverMain } from '../../src/instance/fleetSwitch';
import { releaseFleetBackupBusy } from '../../src/instance/fleetBackupGuards';
import { COPY_PEM, copyFixture, fake, fakeJoin, freshDb, h, mainFixture, resetHarness, seedDbs, stored, writeRegistry } from './switch-harness';

afterAll(() => fs.rmSync(tmp.dir, { recursive: true, force: true }));

/** The login each psql call ran as. */
const psqlLogins = () => fake.calls.filter(c => c.args.includes('psql')).map(c => c.args[c.args.indexOf('-U', c.args.indexOf('psql')) + 1]);
/** Calls that change a login or end or drop a stream. */
const loginChanges = () => fake.calls.filter(c => /ALTER ROLE|DROP ROLE|CREATE ROLE|pg_terminate_backend|pg_drop_replication_slot/.test(`${c.args.join(' ')}\n${c.input}`));

describe('O7 X1 and X9: a planned hand-over', () => {
  beforeEach(() => {
    resetHarness();
    seedDbs();
    fake.dbs['a-pg'].slots.slot_x9 = { active: true, state: 'streaming', replay: '0/5000000' };
    writeRegistry({ a: mainFixture() });
    SWITCH_TIMING.catchUpMs = 60;
    SWITCH_TIMING.pollMs = 5;
    releaseFleetBackupBusy('a');
  });

  it('X1: the hand-over runs as the manager\'s logins and changes no login, so the copy keeps streaming with its own', async () => {
    expect((await handOver('a', 'slot_c', false)).success).toBe(true);
    expect(stored('a').fleetDb.handover).toMatchObject({ mode: 'stream', slot: 'slot_c', phase: 'stopped' });
    const logins = psqlLogins();
    expect(logins.length).toBeGreaterThan(0);
    expect(logins.filter(l => !/^dbm_(admin|meta|work)$/.test(l))).toEqual([]);
    expect(loginChanges()).toEqual([]);
  });

  it('X9: another copy of the old main keeps its stream and its slot through the hand-over', async () => {
    expect((await handOver('a', 'slot_c', false)).success).toBe(true);
    expect(fake.dbs['a-pg'].slots.slot_x9).toMatchObject({ active: true });
    expect(fake.calls.filter(c => `${c.args.join(' ')}\n${c.input}`.includes('slot_x9'))).toEqual([]);
  });
});

describe('O7 X5 and X9: a take-over', () => {
  beforeEach(() => {
    resetHarness();
    fake.dbs['c-pg'] = freshDb({ recovery: true, generation: { generation: 3, machine: 'main.invalid', since: '2026-10-28T10:00:00Z' }, handover: { slot: 'slot_c', machine: 'copy.example', generation: 4 }, addresses: [
      { host: 'main.invalid', port: 15432, slot: null, machine: 'main.invalid', cert: COPY_PEM },
      { host: 'copy.example', port: 5434, slot: 'slot_c', machine: 'copy.example', cert: COPY_PEM },
      { host: 'third.example', port: 5435, slot: 'slot_t', machine: 'third.example', cert: COPY_PEM },
    ], copies: [{ slot: 'slot_c', machine: 'copy.example', client: '10.0.0.2' }, { slot: 'slot_t', machine: 'third.example', client: '10.0.0.3' }] });
    SWITCH_TIMING.replayWaitMs = 50;
    SWITCH_TIMING.pollMs = 5;
  });

  it('X5: a copy with no address is adopted alone: no Enable, no call as the join login or a machine login, and no login change', async () => {
    writeRegistry({ c: copyFixture({ fleetDbReplica: { ...copyFixture().fleetDbReplica as object, publicHost: undefined, hostPort: undefined } }) });
    expect((await takeOverMain('c')).success).toBe(true);
    expect(h.adoptCalls[0].opts).toMatchObject({ op: 'takeover', alone: true });
    expect(stored('c').fleetDb.replication).toBeUndefined();
    expect(psqlLogins().filter(l => /^smdb_(join|copy_)/.test(l))).toEqual([]);
    expect(loginChanges()).toEqual([]);
  });

  it('X9: the other copies of the old main are named for a rejoin, and no login or stream of theirs is touched', async () => {
    writeRegistry({ c: copyFixture() });
    const r = await takeOverMain('c');
    expect(r.success).toBe(true);
    expect(r.text).toContain(" The copies on third.example followed the old main: on each of those machines, Join with this machine's join code, then Re-seed the copy.");
    expect(psqlLogins().filter(l => /^smdb_(join|copy_)/.test(l))).toEqual([]);
    expect(loginChanges()).toEqual([]);
  });
});

describe('O7 X7: the push\'s rejoin', () => {
  const FILE = 'pre-push-2026-10-28T12-00-00-000Z.dump';
  const PUSH_ID = '0123456789abcdef01234567';
  const REPL = { user: 'smdb_join', password: 'receiver-join-pw' };
  const CODE = encodeMoveCode({ ...fakeJoin({ host: 'win.example', port: 5440, machine: 'win.example', db: 'app', app: { user: 'app', password: 'apppw' }, repl: REPL }), recv: { user: 'smdb_receive', password: 'recvpw', id: PUSH_ID }, recvMeta: { user: 'smdb_receive_meta', password: 'metapw' } } as any);
  const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });
  const answers: Record<string, { code: number; stdout: string; stderr: string }> = {
    probe: ok('false\n2|win.example|\n0\n'), counts: ok('count|"public"."t"|3\n'), sums: ok('checksum|"public"."t"|0123456789abcdef0123456789abcdef\n'),
  };

  beforeEach(() => {
    resetHarness();
    releaseFleetBackupBusy('a');
    fake.dbs['a-pg'] = freshDb();
    writeRegistry({ a: mainFixture() });
    fake.run = (args) => answers[args[args.indexOf('--name') + 1].split('-fleet-move-')[1]] ?? ok();
    const dir = path.join(tmp.dir, 'backups', 'a', 'fleet-postgres');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, FILE), 'PGDMP');
    fs.writeFileSync(path.join(dir, `${FILE}.json`), JSON.stringify({ file: FILE, takenAt: 1, family: 'main', kind: 'safety', inRecovery: false, dataAt: null, dbBytes: 1, counts: { '"public"."t"': 3 }, tables: 1, rows: 3 }));
  });

  it('X7: the rejoin gets a join code for the receiver that carries the move code\'s join login', async () => {
    expect((await push('a', CODE)).success).toBe(true);
    expect(h.reseedCalls).toHaveLength(1);
    const d = decodeJoinCode(h.reseedCalls[0].code);
    expect(d.ok).toBe(true);
    if (d.ok) expect({ host: d.code.host, port: d.code.port, repl: d.code.repl }).toEqual({ host: 'win.example', port: 5440, repl: REPL });
  });
});
