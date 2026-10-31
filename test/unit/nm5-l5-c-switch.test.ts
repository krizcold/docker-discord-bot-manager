import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const tmp = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm5-l5-c-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return { dir };
});
const v = vi.hoisted(() => ({ pulled: null as string | null, purposes: [] as unknown[], publicHost: 'copy.example' }));

vi.mock('child_process', async (o) => (await import('./switch-harness')).childProcessMock(await o()));
vi.mock('../../src/instance/dbLogin', async (o) => (await import('./switch-harness')).dbLoginMock(await o()));
vi.mock('../../src/instance/maintenance', async (o) => (await import('./switch-harness')).maintenanceMock(await o()));
vi.mock('../../src/docker/containerManager', async (o) => (await import('./switch-harness')).containerManagerMock(await o()));
vi.mock('../../src/instance/fleetBackup', async (o) => (await import('./switch-harness')).fleetBackupMock(await o()));
vi.mock('../../src/instance/fleetJoin', async (o) => {
  const m = (await import('./switch-harness')).fleetJoinMock(await o()) as Record<string, any>;
  return {
    ...m,
    ensureClientImage: async () => v.pulled,
    peerProbe: async (inst: unknown, code: unknown, pem: string, purpose: unknown) => { v.purposes.push(purpose); return m.peerProbe(inst, code, pem, purpose); },
  };
});
vi.mock('../../src/instance/fleetReplica', async (o) => {
  const m = (await import('./switch-harness')).fleetReplicaMock(await o()) as Record<string, any>;
  const { h: hh } = await import('./switch-harness');
  return {
    ...m,
    adoptPromotedReplica: async (inst: { id: string }, opts: any = {}) => {
      hh.adoptCalls.push({ opts });
      hh.events.push('adopt');
      if (hh.adopt) return hh.adopt;
      const cm = await import('../../src/docker/containerManager');
      const repl = opts.alone ? undefined : { role: 'replicator', password: 'replpass', hostPort: 5434, publicHost: v.publicHost, certHost: v.publicHost };
      const r = cm.adoptFleetDbReplicaAsPrimary(inst.id, repl as any, opts.restoreNotice, opts.formerMain);
      return r.success ? { success: true, restartRequired: true, flipped: true, ...(opts.alone ? { alone: true } : {}) } : r;
    },
  };
});
vi.mock('../../src/instance/appHookClient', async (o) => (await import('./switch-harness')).appHookMock(await o()));
vi.mock('../../src/instance/backupCheck', async (o) => (await import('./switch-harness')).backupCheckMock(await o()));
vi.mock('../../src/env/manager', async (o) => (await import('./switch-harness')).envMock(await o()));
vi.mock('../../src/config/appCapabilities', async (o) => (await import('./switch-harness')).capsMock(await o()));

import * as fs from 'fs';
import { cancelHandOver, handOver, keepThisMain, noticeLine, stepNotice, SWITCH_TIMING, takeOver, takeOverMain } from '../../src/instance/fleetSwitch';
import { claimFleetBackupBusy, releaseFleetBackupBusy } from '../../src/instance/fleetBackupGuards';
import { COPY_PEM, copyFixture, fake, freshDb, h, mainFixture, resetHarness, seedDbs, stored, writeRegistry } from './switch-harness';

const NOTHING = '; nothing was changed';
const ORDER = 'The bot is running normally: its database login is restored, and it took the order to leave maintenance.';
const peer = (kind: string, sys = '7001') => () => (kind === 'writable' || kind === 'in-recovery'
  ? { kind, systemId: sys, timeline: 2, gen: null }
  : kind === 'fenced' ? { kind, systemId: sys, reason: 'FATAL:  fenced here' }
  : { kind, reason: 'connection refused' }) as any;
const withTakeover = (t: Record<string, unknown>) => writeRegistry({ c: copyFixture({ fleetDbReplica: { ...copyFixture().fleetDbReplica as object, takeover: t } }) });
const promotedCopy = () => {
  fake.dbs['c-pg'].recovery = false;
  h.copyFacts = { ok: true, facts: { inRecovery: false, streaming: false, systemId: '7001', timeline: 2, lsn: 1n } };
};
const switchLines = (spy: { mock: { calls: unknown[][] } }) => spy.mock.calls.map(c => String(c[0])).filter(s => s.startsWith('[Switch]'));

beforeEach(() => {
  resetHarness();
  v.pulled = null;
  v.purposes = [];
  v.publicHost = 'copy.example';
  fake.dbs['c-pg'] = freshDb({ recovery: true, generation: { generation: 3, machine: 'main.invalid', since: '2026-10-28T10:00:00Z' }, handover: { slot: 'slot_c', machine: 'copy.example', generation: 4 }, addresses: [
    { host: 'main.invalid', port: 15432, slot: null, machine: 'main.invalid', cert: COPY_PEM },
    { host: 'copy.example', port: 5434, slot: 'slot_c', machine: 'copy.example', cert: COPY_PEM },
  ], copies: [{ slot: 'slot_c', machine: 'copy.example', client: '10.0.0.2' }, { slot: 'slot_t', machine: 'third.example', client: '10.0.0.3' }] });
  writeRegistry({ c: copyFixture() });
  SWITCH_TIMING.replayWaitMs = 50;
  SWITCH_TIMING.pollMs = 5;
  releaseFleetBackupBusy('c');
});
afterEach(() => vi.restoreAllMocks());
afterAll(() => fs.rmSync(tmp.dir, { recursive: true, force: true }));

describe('L5 c: Take over', () => {
  it('a claimed backup slot refuses before any read', async () => {
    expect(claimFleetBackupBusy('c')).toBe(true);
    expect(await takeOverMain('c')).toEqual({ success: false, status: 409, text: `A backup or restore operation is in progress on this database; wait for it to finish${NOTHING}` });
    releaseFleetBackupBusy('c');
    expect(fake.calls).toEqual([]);
  });

  it('the bot database missing on the copy, with no restore pending: no restore clause', async () => {
    fake.dbs['c-pg'].botDbMissing = true;
    expect((await takeOverMain('c')).text).toBe(`The bot's database is missing on this copy (it replayed the drop of a restore), so there is nothing to take over${NOTHING}`);
  });

  it('the existence check and the receive mark read run in the postgres database', async () => {
    fake.dbs['c-pg'].receiveMark = { markId: 'a1', pushIds: ['b1'], dbOid: '16384' };
    await takeOverMain('c');
    const dbOf = (part: string) => fake.calls.filter(c => c.input.includes(part)).map(c => c.args[c.args.indexOf('-d') + 1]);
    expect(dbOf('FROM pg_database WHERE datname')).toContain('postgres');
    expect(dbOf('count(*) FROM pg_database').every(d => d === 'postgres')).toBe(true);
    expect(dbOf("FROM smdb_manager.receive_mark), '')")).toEqual(['postgres']);
    expect(dbOf('oid::text FROM pg_database WHERE datname')).toEqual(['postgres']);
  });

  it('the existence check fails', async () => {
    fake.dbs['c-pg'].fail.exists = 'ERROR:  exists failed';
    expect((await takeOverMain('c')).text).toBe(`The copy's database did not answer (ERROR:  exists failed); start the instance and try again${NOTHING}`);
  });

  it('the restore record read fails', async () => {
    fake.dbs['c-pg'].fail['restore-read'] = 'ERROR:  restore read failed';
    expect((await takeOverMain('c')).text).toBe(`The copy's database did not answer (ERROR:  restore read failed); start the instance and try again${NOTHING}`);
  });

  it('replay catches up on the second read inside the wait', async () => {
    fake.dbs['c-pg'].receiveLsn = '0/6000000';
    let reads = 0;
    fake.dbs['c-pg'].beforeAnswer = sql => { if (sql.includes('pg_last_xact_replay_timestamp()') && ++reads === 2) fake.dbs['c-pg'].replayLsn = '0/6000000'; };
    expect((await takeOverMain('c')).success).toBe(true);
    expect(reads).toBeGreaterThanOrEqual(2);
  });

  it('a zero wait on a frozen clock refuses on the first behind read', async () => {
    SWITCH_TIMING.replayWaitMs = 0;
    const t0 = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(t0);
    fake.dbs['c-pg'].receiveLsn = '0/6000000';
    let reads = 0;
    fake.dbs['c-pg'].beforeAnswer = sql => { if (sql.includes('pg_last_xact_replay_timestamp()') && ++reads === 2) fake.dbs['c-pg'].replayLsn = '0/6000000'; };
    expect((await takeOverMain('c')).text).toBe(`The copy received changes it has not applied yet after 0 seconds; try again in a moment${NOTHING}`);
    expect(reads).toBe(1);
  });

  it('replay that never catches up refuses at the deadline', async () => {
    fake.dbs['c-pg'].receiveLsn = '0/6000000';
    expect((await takeOverMain('c')).text).toBe(`The copy received changes it has not applied yet after 0 seconds; try again in a moment${NOTHING}`);
  }, 3000);

  it('the restore record floor above the live generation sets the target and the former generation', async () => {
    fake.dbs['c-pg'].handover = null;
    fake.dbs['c-pg'].restoreState = { pending: false, file: 'old.dump', at: '2026-10-28T09:00:00Z', generation: 5, machine: 'old.invalid', since: null };
    const r = await takeOverMain('c', { confirm: true });
    expect(r.text).toMatch(/^This machine is the main now \(generation 6, /);
    expect(h.adoptCalls[0].opts).toMatchObject({ formerMain: { machine: 'main.invalid', generation: 5 } });
  });

  it('a withdrawal whose intent write throws keeps the intent and says so', async () => {
    fake.dbs['c-pg'].handover = null;
    h.peer = peer('writable');
    withTakeover({ startedAt: 'x', planned: false, generation: 4 });
    h.failTakeoverWrite = 'disk full';
    const r = await takeOverMain('c');
    expect(r.text).toBe(`The main at main.invalid:15432 still answers as the main, so this copy was not promoted. Hand it over from its own manager (that loses nothing), or stop it first${NOTHING} The unfinished take-over stays recorded, and this copy still refuses the bot's login (disk full); press Take over again to retry the withdrawal.`);
  });

  it('a resume after promotion: unplanned text with no replay time, intent not rewritten, the unplanned log line', async () => {
    promotedCopy();
    withTakeover({ startedAt: 'x', planned: false, generation: 4 });
    h.failTakeoverWrite = 'disk full';
    const log = vi.spyOn(console, 'log');
    const r = await takeOverMain('c');
    expect(r.success).toBe(true);
    expect(r.text).toMatch(/^This machine is the main now \(generation 4, \d{4}-\d\d-\d\d \d\d:\d\d UTC\)\. The old main's changes after an unknown time are not here\. /);
    expect(switchLines(log)).toContain('[Switch] C: took over as the main (generation 4, unplanned)');
  });

  it('a planned intent left in recovery, retried with no hand-over row: unplanned', async () => {
    fake.dbs['c-pg'].handover = null;
    withTakeover({ startedAt: 'x', planned: true, generation: 4 });
    const r = await takeOverMain('c', { confirm: true });
    expect(r.text).toMatch(/^This machine is the main now \(generation 4, \d{4}-\d\d-\d\d \d\d:\d\d UTC\)\. The old main's changes after /);
  });

  it('a planned take-over logs planned and warns of nothing', async () => {
    const log = vi.spyOn(console, 'log');
    const warn = vi.spyOn(console, 'warn');
    expect((await takeOverMain('c')).success).toBe(true);
    expect(switchLines(log)).toContain('[Switch] C: took over as the main (generation 4, planned)');
    expect(switchLines(warn)).toEqual([]);
    expect(h.events).not.toContain('start-bot');
  });

  it('a receive mark with an empty oid still reads the received rows', async () => {
    fake.dbs['c-pg'].receiveMark = { markId: 'a1', pushIds: ['b1'], dbOid: '' };
    fake.dbs['c-pg'].dbOid = '';
    fake.dbs['c-pg'].received = [{ pushId: 'b1', from: 'x', machine: 'pusher.example', generation: 3 }];
    const r = await takeOverMain('c');
    expect(r.success).toBe(true);
    expect(r.text).toMatch(/^This machine is the main now \(generation 4, /);
  });

  it('the hand-over row read fails', async () => {
    fake.dbs['c-pg'].fail['handover-read'] = 'ERROR:  handover read failed';
    expect((await takeOverMain('c')).text).toBe(`The copy's database did not answer (ERROR:  handover read failed); start the instance and try again${NOTHING}`);
  });

  it.each([['4x'], ['x4'], ['45']])('a hand-over row naming another slot with generation %s', async (gen) => {
    fake.dbs['c-pg'].handover = { slot: 'slot_t', machine: 'third.example', generation: gen as unknown as number };
    const r = await takeOverMain('c');
    if (gen === '45') expect(r.text).toBe(`The main was handed over to third.example, not to this copy; take over on third.example's manager${NOTHING}`);
    else expect(r).toMatchObject({ success: false, needsConfirm: true });
  });

  it('no join code: the warning names the recorded main address', async () => {
    fake.dbs['c-pg'].handover = null;
    writeRegistry({ c: copyFixture({ fleetJoin: undefined }) });
    expect((await takeOverMain('c')).text).toContain('The main at main.invalid:15432 did not answer (the join code stored here cannot be read, so the main was not checked).');
  });

  it('no join code: the raise drops the copy rows only', async () => {
    writeRegistry({ c: copyFixture({ fleetJoin: undefined }) });
    expect((await takeOverMain('c')).success).toBe(true);
    expect(fake.dbs['c-pg'].addresses.map(a => a.host)).toEqual(['main.invalid']);
  });

  it('the certificate read fails: its reason in the warning', async () => {
    fake.dbs['c-pg'].handover = null;
    h.cert = { ok: false, kind: 'unreachable', reason: 'certificate read timed out', text: 'x' };
    expect((await takeOverMain('c')).text).toContain('did not answer (certificate read timed out).');
  });

  it('the client image cannot be pulled: its reason in the warning', async () => {
    fake.dbs['c-pg'].handover = null;
    v.pulled = 'the client image could not be pulled';
    expect((await takeOverMain('c')).text).toContain('did not answer (the client image could not be pulled).');
  });

  it('the old main is probed with the takeover purpose', async () => {
    await takeOverMain('c');
    expect(v.purposes).toEqual(['takeover']);
  });

  it.each([['writable'], ['in-recovery']])('a %s database of another system at the old address', async (kind) => {
    fake.dbs['c-pg'].handover = null;
    h.peer = peer(kind, '9999');
    expect((await takeOverMain('c')).text).toContain('did not answer (another database answers there (system id 9999)).');
  });

  it('a fenced database of another system at the old address', async () => {
    fake.dbs['c-pg'].handover = null;
    h.peer = peer('fenced', '9999');
    const r = await takeOverMain('c');
    expect(r).toMatchObject({ needsConfirm: true });
    expect(r.text).toContain('did not answer (FATAL:  fenced here).');
  });

  it('the intent keeps the pending restore it inherits when the raise fails', async () => {
    fake.dbs['c-pg'].handover = null;
    fake.dbs['c-pg'].restoreState = { pending: true, file: 'old.dump', at: '2026-10-28T09:00:00Z', generation: 3, machine: 'main.invalid', since: null };
    fake.dbs['c-pg'].fail.raise = 'ERROR:  disk full';
    await takeOverMain('c', { confirm: true });
    expect(stored('c').fleetDbReplica.takeover.inherit).toEqual({ file: 'old.dump', at: '2026-10-28T09:00:00Z' });
  });

  it('admit is called once the intent is recorded', async () => {
    const admit = vi.fn();
    const r = await takeOver('c', {}, admit);
    expect(admit).toHaveBeenCalledTimes(1);
    expect(r.after).toBeDefined();
  });

  it('the bot removed before the tail: success with the text so far', async () => {
    const r = await takeOver('c', {});
    writeRegistry({});
    const done = await r.after!();
    expect(done.success).toBe(true);
    expect(done.text).toMatch(/^This machine is the main now/);
  });

  it('no notice answer: the text ends with the order text', async () => {
    const r = await takeOver('c', {});
    fake.dbs['c-pg'].fail['gen-read'] = 'ERROR:  gen read failed';
    const done = await r.after!();
    expect(done.text.endsWith(` ${ORDER}`)).toBe(true);
  });

  it('Enable failed with no error text', async () => {
    h.adopt = { success: false, flipped: true };
    expect((await takeOverMain('c')).text).toContain(' Replication could not be enabled here (no reason given); enable');
  });

  it('no other copies listed: no copies sentence', async () => {
    fake.dbs['c-pg'].copies = [];
    const r = await takeOverMain('c');
    expect(r.success).toBe(true);
    expect(r.text).not.toContain('The copies on');
    expect(r.text).not.toContain('Stryker');
  });

  it('a copies answer whose last line starts with spaces', async () => {
    fake.dbs['c-pg'].copies = [{ slot: 'slot_t', machine: 'x\n  third.example', client: null }];
    expect((await takeOverMain('c')).text).toContain(' The copies on third.example followed the old main');
  });

  it('a restore notice in memory: the bot not started', async () => {
    h.memoryNotice = 'x.dump';
    const r = await takeOverMain('c');
    expect(r.text).toContain(" The bot was not started: the old main's restore had not finished, and its notice is on the Database window.");
    expect(h.events).not.toContain('order:running');
  });

  it('an unsettled order with the app stopped starts nothing', async () => {
    h.order = { settled: false, text: 'Running is not confirmed: x.' };
    h.app = false;
    await takeOverMain('c');
    expect(h.events).not.toContain('start-bot');
  });

  it('a settled order with the app stopped starts the bot and reports nothing on success', async () => {
    h.app = false;
    const r = await takeOverMain('c');
    expect(h.events).toContain('start-bot');
    expect(r.text).not.toContain('did not start');
  });

  it('a failed start with no error text', async () => {
    h.app = false;
    h.start = { success: false };
    expect((await takeOverMain('c')).text).toContain(' The bot did not start (no reason given); press Start.');
  });

  it('a start that throws', async () => {
    h.app = false;
    Object.defineProperty(h, 'start', { configurable: true, get() { throw new Error('docker gone'); } });
    try {
      expect((await takeOverMain('c')).text).toContain(' The bot did not start (docker gone); press Start.');
    } finally {
      Object.defineProperty(h, 'start', { configurable: true, writable: true, enumerable: true, value: { success: true } });
    }
  });

  const IP_TAIL = " Other machines reach this database at the IP address 10.1.2.3; a bot build that cannot check a certificate by IP address cannot connect to it (this bot's build has no switch-notice hook, so it is such a build). Update the bots, or give this machine a DNS name and enable replication with it.";
  it('no notice hook and an IP address: the IP tail', async () => {
    v.publicHost = '10.1.2.3';
    h.hook = () => ({ ok: false, status: 404, error: 'no route' });
    expect((await takeOverMain('c')).text.endsWith(IP_TAIL)).toBe(true);
  });
  it('no notice hook and a DNS name: no IP tail', async () => {
    h.hook = () => ({ ok: false, status: 404, error: 'no route' });
    expect((await takeOverMain('c')).text).not.toContain('Other machines reach this database');
  });
  it('a sent notice and an IP address: no IP tail', async () => {
    v.publicHost = '10.1.2.3';
    expect((await takeOverMain('c')).text).not.toContain('Other machines reach this database');
  });
});

describe('L5 c: lane names and defaults', () => {
  it('handOver without confirm asks on a stopped hold', async () => {
    resetHarness();
    seedDbs();
    writeRegistry({ a: mainFixture() });
    SWITCH_TIMING.catchUpMs = 60;
    releaseFleetBackupBusy('a');
    h.proof = { ok: true, state: 'off', enforcement: 'database', botConfirmed: false, held: { state: 'stopped' } };
    expect(await handOver('a', 'slot_c')).toMatchObject({ success: false, needsConfirm: true });
  });

  it.each([['keep-main'], ['handover']])('a second lane names the running %s lane', async (op) => {
    resetHarness();
    seedDbs();
    let release!: () => void;
    const held = new Promise<void>(r => { release = r; });
    if (op === 'keep-main') {
      writeRegistry({ a: mainFixture({ fleetDb: { ...mainFixture().fleetDb as object, mainConflict: { machine: 'b.example', host: 'b.example', port: 5440, generation: 3, at: 'x', cert: COPY_PEM } } }) });
    } else {
      fake.dbs['a-pg'].handover = { slot: 'slot_c', machine: 'copy.example', generation: 4 };
      writeRegistry({ a: mainFixture({ fleetDb: { ...mainFixture().fleetDb as object, handover: { mode: 'stream', slot: 'slot_c', machine: 'copy.example', host: 'copy.example', port: 5434, cert: COPY_PEM, generation: 4, phase: 'stopped', at: '2026-10-28T12:00:00.000Z' } } }) });
      h.sidecar['a-pg'] = false;
    }
    h.peer = (() => held.then(() => ({ kind: 'unreachable', reason: 'connection refused' }))) as any;
    const first = op === 'keep-main' ? keepThisMain('a') : cancelHandOver('a');
    for (let i = 0; i < 50 && !h.events.some(e => e.startsWith('probe:')); i++) await new Promise(r => setTimeout(r, 5));
    expect((await takeOverMain('a')).text).toBe(`Operation '${op}' is running on this bot; wait for it to finish${NOTHING}`);
    release();
    await first;
  });
});

describe('L5 c: the switch notice', () => {
  const N = { generation: 4, machine: 'copy.example', since: null };
  it.each([
    [{ ...N, state: 'sent' }, 'The owner was sent a switch notice for generation 4 on an unknown date.'],
    [{ ...N, state: 'already', triedAt: 0 }, 'The bot posted no new switch notice for generation 4 on an unknown date: no reason given'],
    [{ ...N, state: 'refused' }, 'The bot did not post the switch notice for generation 4 (no reason given). The manager asks again every hour while this database holds that generation.'],
    [{ ...N, state: 'unknown' }, "Whether the switch notice for generation 4 was posted can't be confirmed (no reason given); the manager asks again within an hour, and the bot posts it only if it finds no notice of that generation."],
    [{ ...N, state: 'pending' }, 'The switch notice for generation 4 is not sent yet (not tried yet); the manager tries again every hour.'],
    [{ ...N, state: 'pending', error: 'timeout' }, 'The switch notice for generation 4 is not sent yet (timeout); the manager tries again every hour.'],
  ])('noticeLine %j', (n, text) => {
    expect(noticeLine(n as any)).toBe(text);
  });

  const main = (gen: number, notice?: Record<string, unknown>) => {
    resetHarness();
    seedDbs();
    fake.dbs['a-pg'].generation = { generation: gen, machine: 'main.example', since: '2026-10-28T10:00:00Z' };
    writeRegistry({ a: mainFixture({ fleetDb: { ...mainFixture().fleetDb as object, ...(notice ? { switchNotice: notice } : {}) } }) });
  };

  it('generation 1 with the bot stopped owes nothing', async () => {
    main(1);
    h.app = false;
    expect(await stepNotice('a')).toBeNull();
    expect(stored('a').fleetDb.switchNotice).toBeUndefined();
  });

  it('generation 2 with the bot running sends', async () => {
    main(2);
    expect((await stepNotice('a'))?.state).toBe('sent');
    expect(h.hookCalls.length).toBe(1);
  });

  it('the bot stopped and no record: a waiting record is saved', async () => {
    main(3);
    h.app = false;
    expect(await stepNotice('a')).toEqual({ generation: 3, machine: 'main.example', since: '2026-10-28T10:00:00Z', state: 'pending', waiting: true });
    expect(stored('a').fleetDb.switchNotice).toEqual({ generation: 3, machine: 'main.example', since: '2026-10-28T10:00:00Z', state: 'pending', waiting: true });
  });

  it('the bot stopped and a record of an older generation: a waiting record of this one', async () => {
    main(4, { generation: 3, machine: 'x', since: null, state: 'sent' });
    h.app = false;
    expect(await stepNotice('a')).toMatchObject({ generation: 4, waiting: true });
    expect(stored('a').fleetDb.switchNotice).toMatchObject({ generation: 4, waiting: true });
  });

  it('the bot stopped and a waiting record: it is not rewritten', async () => {
    main(3, { generation: 3, machine: 'old.example', since: null, state: 'pending', waiting: true });
    h.app = false;
    await stepNotice('a');
    expect(stored('a').fleetDb.switchNotice.machine).toBe('old.example');
  });

  it('the pending record cannot be saved: the error line, no hook', async () => {
    main(3);
    h.failSwitchWrite = 'disk full';
    const err = vi.spyOn(console, 'error');
    expect(await stepNotice('a')).toBeNull();
    expect(switchLines(err)).toEqual(['[Switch] A: the switch notice was not sent, because the manager could not record it first (disk full)']);
    expect(h.hookCalls).toEqual([]);
  });

  it('a sent notice logs no error', async () => {
    main(3);
    const err = vi.spyOn(console, 'error');
    await stepNotice('a');
    expect(switchLines(err)).toEqual([]);
  });

  it('the outcome cannot be saved: its error line', async () => {
    main(3);
    h.hook = () => { h.failSwitchWrite = 'disk full'; return { ok: true, status: 200 }; };
    const err = vi.spyOn(console, 'error');
    await stepNotice('a');
    expect(switchLines(err)).toEqual(['[Switch] A: the switch notice outcome could not be recorded (disk full)']);
  });
});
