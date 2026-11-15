import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const tmp = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm22-l5-d-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return { dir };
});

type Hang = { re: RegExp; stdout: string } | null;
const hang = vi.hoisted(() => ({ now: null as Hang }));

vi.mock('child_process', async (o) => {
  const real = await o<typeof import('child_process')>();
  const base = (await import('./switch-harness')).childProcessMock(real) as any;
  const { EventEmitter } = await import('events');
  const { PassThrough } = await import('stream');
  const { switchSpawn, answerSql } = await import('./switch-fake');
  const spawn = (cmd: string, args: string[], opts?: any) => {
    const h = hang.now;
    if (!h || cmd !== 'docker' || args[0] !== 'exec' || !args.includes('psql')) return switchSpawn(cmd, args, opts);
    const c: any = new EventEmitter();
    c.stdout = new PassThrough();
    c.stderr = new PassThrough();
    c.stdin = new PassThrough();
    c.kill = () => true;
    let input = '';
    c.stdin.on('data', (d: Buffer) => { input += d.toString(); });
    c.stdin.on('finish', () => {
      if (h.re.test(input)) { c.stdout.write(h.stdout); return; }
      const a = answerSql(args[args.indexOf('psql') - 1], args[args.indexOf('-d') + 1], input);
      setTimeout(() => { c.stdout.end(a.stdout); c.stderr.end(a.stderr); setTimeout(() => c.emit('close', a.code), 1); }, 1);
    });
    return c;
  };
  return { ...base, spawn, default: { ...base.default, spawn } };
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
import { composeJoinCode, ownPeersSql, resetSwitchState, SWITCH_TIMING, switchTick } from '../../src/instance/fleetSwitch';
import { releaseFleetBackupBusy } from '../../src/instance/fleetBackupGuards';
import { fake, freshDb, h, mainFixture, MAIN, resetHarness, writeRegistry } from './switch-harness';

const ID = '0f1e2d3c-4b5a-4968-8776-655443322110';
const hex = (c: string) => c.repeat(32);
const SLOT_B = `fleet_standby_${hex('b')}`;
const SLOT_D = `fleet_standby_${hex('d')}`;
const LOGIN_B = `smdb_copy_${hex('b')}`;
const LOGIN_C = `smdb_copy_${hex('c')}`;
let now = Date.parse('2026-11-16T10:00:00Z');
const warns: string[] = [];
const logs: string[] = [];
const ev = (p: string) => h.events.filter(e => e.startsWith(p));
const SLOT_FAIL = (slot: string, user: string, why: string) => `[Switch] A: the stream on the slot ${slot} by ${user} could not be ended and its slot could not be dropped (${why}); the manager tries again every 5 minutes`;
const STEP_TEXTS = ["the streams on the machines' slots could not be read", 'the open sessions of blocked machine logins could not be checked', 'the large objects in the postgres database could not be checked', 'the machine logins could not be read'];

const tick = async () => { now += 6 * 60_000; await switchTick(now); };

beforeEach(() => {
  resetHarness();
  resetSwitchState();
  releaseFleetBackupBusy(ID);
  hang.now = null;
  fake.dbs['a-pg'] = freshDb();
  writeRegistry({ [ID]: mainFixture({ displayName: 'A', fleetDb: { ...MAIN } }) });
  warns.length = 0;
  logs.length = 0;
  vi.spyOn(console, 'warn').mockImplementation((m: unknown) => { warns.push(String(m)); });
  vi.spyOn(console, 'log').mockImplementation((m: unknown) => { logs.push(String(m)); });
});
afterEach(() => { hang.now = null; vi.restoreAllMocks(); });
afterAll(() => fs.rmSync(tmp.dir, { recursive: true, force: true }));

describe('NM22 L5 d: composeJoinCode and ownPeersSql', () => {
  it('composeJoinCode on an instance with no main database answers the exact reason', () => {
    expect(composeJoinCode({ id: ID, displayName: 'A' } as any, { host: 'h', port: 1, cert: 'c', machine: 'm' })).toEqual({ ok: false, error: 'this instance holds no main database' });
  });

  it('ownPeersSql refuses a text that is not a slot name, naming it', () => {
    expect(() => ownPeersSql("x' OR true --")).toThrow("x' OR true -- is not a slot name");
    expect(ownPeersSql(SLOT_B)).toContain(`a.slot <> '${SLOT_B}'`);
  });
});

describe('NM22 L5 d: the machine logins check (R3)', () => {
  it('a clean tick logs no step failure', async () => {
    fake.dbs['a-pg'].foreign = [`${SLOT_B}|${LOGIN_C}|4242`];
    await tick();
    expect(ev('new-logins')).toHaveLength(1);
    expect(warns.filter(l => STEP_TEXTS.some(t => l.includes(t)) || l.includes('could not be ended and its slot'))).toEqual([]);
  });

  it('a read that recovers logs nothing for the recovery', async () => {
    fake.dbs['a-pg'].fail['foreign-read'] = 'ERROR:  out of shared memory';
    await tick();
    expect(warns).toEqual(["[Switch] A: the streams on the machines' slots could not be read (ERROR:  out of shared memory); the manager tries again every 5 minutes"]);
    delete fake.dbs['a-pg'].fail['foreign-read'];
    warns.length = 0;
    await tick();
    expect(warns).toEqual([]);
  });

  it.each([
    ['a last line of another form', 'true\ngarbage', 'garbage'],
    ['one line before the slot line that is not true or false', 'garbage\nslot|dropped', 'slot|dropped'],
    ['two lines before the slot line', 'true\ntrue\nslot|dropped', 'slot|dropped'],
  ])('the slot step answers %s: the step is logged as unread and nothing is said about the stream', async (_n, answer, last) => {
    fake.dbs['a-pg'].foreign = [`${SLOT_B}|${LOGIN_C}|4242`];
    fake.dbs['a-pg'].tainted[SLOT_B] = answer;
    await tick();
    expect(warns).toEqual([SLOT_FAIL(SLOT_B, LOGIN_C, `the answer was not in the form the manager reads: ${last}`)]);
  });

  it('a role that is not a machine login, its stream already gone: the line says it had already ended', async () => {
    fake.dbs['a-pg'].foreign = [`${SLOT_B}|botrole|90`];
    fake.dbs['a-pg'].tainted[SLOT_B] = 'slot|dropped';
    await tick();
    expect(warns).toContain(`[Switch] A: the role botrole streamed on the slot ${SLOT_B}, which belongs to a machine login. Its stream had already ended; the slot was dropped, so its machine rebuilds its copy. It is not a machine login, so it was not blocked.`);
  });

  it('two slots whose slot step fails with one error: one line each', async () => {
    fake.dbs['a-pg'].foreign = [`${SLOT_B}|botrole|90`, `${SLOT_D}|botrole|91`];
    fake.dbs['a-pg'].fail.tainted = 'ERROR:  out of shared memory';
    await tick();
    expect(warns).toEqual([SLOT_FAIL(SLOT_B, 'botrole', 'ERROR:  out of shared memory'), SLOT_FAIL(SLOT_D, 'botrole', 'ERROR:  out of shared memory')]);
  });

  it('a slot step that fails, succeeds, then fails with the same error is logged again', async () => {
    fake.dbs['a-pg'].foreign = [`${SLOT_B}|botrole|90`];
    fake.dbs['a-pg'].fail.tainted = 'ERROR:  out of shared memory';
    await tick();
    delete fake.dbs['a-pg'].fail.tainted;
    await tick();
    fake.dbs['a-pg'].fail.tainted = 'ERROR:  out of shared memory';
    await tick();
    expect(warns.filter(l => l.includes('could not be ended and its slot'))).toEqual([SLOT_FAIL(SLOT_B, 'botrole', 'ERROR:  out of shared memory'), SLOT_FAIL(SLOT_B, 'botrole', 'ERROR:  out of shared memory')]);
  });

  it('resetSwitchState forgets the logged errors and unread lines', async () => {
    fake.dbs['a-pg'].fail['blocked-sessions'] = 'ERROR:  out of shared memory';
    fake.dbs['a-pg'].foreign = [`${SLOT_B}|${LOGIN_C}|4242|x`];
    await tick();
    resetSwitchState();
    await tick();
    expect(warns.filter(l => l.includes('open sessions of blocked'))).toHaveLength(2);
    expect(warns.filter(l => l.includes('is not in the form the manager reads'))).toHaveLength(2);
  });

  it('large objects counted in two digits are logged with their count', async () => {
    fake.dbs['a-pg'].lobj = ['smdb_join|12'];
    await tick();
    expect(warns).toContain('[Switch] A: removed 12 large objects that smdb_join made in the postgres database; the manager keeps none there');
  });

  it('a group left with no members logs no new login, and a later member is logged once', async () => {
    fake.dbs['a-pg'].members = [LOGIN_B];
    await tick();
    fake.dbs['a-pg'].members = [];
    await tick();
    fake.dbs['a-pg'].members = [LOGIN_C];
    await tick();
    expect(logs.filter(l => l.includes('got a login with the join code'))).toEqual([`[Switch] A: a machine got a login with the join code: ${LOGIN_C}`]);
  });

  it.each([
    ['the streams read', /r\.usename IS DISTINCT FROM 'smdb_copy_'/, `${SLOT_B}|${LOGIN_C}|4242\n`, "the streams on the machines' slots could not be read"],
    ['the blocked sessions read', /a\.client_addr IS NOT NULL/, `${LOGIN_B}|true\n`, 'the open sessions of blocked machine logins could not be checked'],
    ['the large objects sweep', /pg_largeobject_metadata/, 'smdb_join|2\n', 'the large objects in the postgres database could not be checked'],
  ])('%s prints its rows and gives no answer in time: no row of it is acted on', async (_n, re, stdout, what) => {
    const readMs = SWITCH_TIMING.readMs;
    SWITCH_TIMING.readMs = 1000;
    hang.now = { re, stdout };
    try { await tick(); } finally { SWITCH_TIMING.readMs = readMs; }
    expect(warns.filter(l => l.includes(what))).toEqual([`[Switch] A: ${what} (no answer within 1 seconds); the manager tries again every 5 minutes`]);
    expect(ev('block:')).toEqual([]);
    expect(ev('tainted:')).toEqual([]);
    expect(warns.filter(l => l.includes('ended an open session') || l.includes('removed 2 large objects'))).toEqual([]);
  }, 30_000);

  it('the members read prints its row and gives no answer in time: the next read sets the first list, so no login is announced', async () => {
    const readMs = SWITCH_TIMING.readMs;
    SWITCH_TIMING.readMs = 1000;
    hang.now = { re: /string_agg\(m\.member/, stdout: '\n' };
    try { await tick(); } finally { SWITCH_TIMING.readMs = readMs; hang.now = null; }
    expect(warns).toContain('[Switch] A: the machine logins could not be read (no answer within 1 seconds); the manager tries again every 5 minutes');
    fake.dbs['a-pg'].members = [LOGIN_B];
    await tick();
    expect(logs.filter(l => l.includes('got a login with the join code'))).toEqual([]);
  }, 30_000);
});
