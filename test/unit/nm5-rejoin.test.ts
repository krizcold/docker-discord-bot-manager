import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const tmp = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm5-rejoin-'));
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
import { decodeJoinCode } from '../../src/config/joinCode';
import { rejoinComposed, resetSwitchState, switchTick, switchView } from '../../src/instance/fleetSwitch';
import { COPY_PEM, fake, freshDb, h, mainFixture, resetHarness, stored, writeRegistry } from './switch-harness';
import { COPY_FP, fakeJoinCode } from './join-fake';

const MARK = { mode: 'stream', phase: 'stopped', slot: 'slot_c', machine: 'copy.example', host: 'copy.example', port: 5434, cert: COPY_PEM, generation: 4, at: '2026-10-30T09:00:00.000Z' };
const writable = (g: number, sys = '7001', receiveMark: boolean | null = false, machine = 'copy.example') => () => ({ kind: 'writable', systemId: sys, timeline: 2, gen: { generation: g, machine, since: null }, receiveMark }) as any;
const handedOver = (mark: Record<string, unknown> = MARK) => writeRegistry({ a: mainFixture({ fleetDb: { ...(mainFixture().fleetDb as object), handover: mark } }) });
let now = Date.parse('2026-10-30T10:00:00Z');

beforeEach(() => {
  resetHarness();
  resetSwitchState();
  fake.dbs['a-pg'] = freshDb();
  h.sidecar['a-pg'] = false;
  handedOver();
  now += 31 * 60_000;
});
afterAll(() => fs.rmSync(tmp.dir, { recursive: true, force: true }));

describe('O4 the old main rejoins as a copy', () => {
  it("J1: the target writable at the mark's generation: the re-seed starts with the composed code, logged J-LOG-START", async () => {
    h.peer = writable(4);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await switchTick(now);
    const logs = log.mock.calls.map(c => String(c[0]));
    log.mockRestore();
    expect(h.reseedCalls).toHaveLength(1);
    const code = decodeJoinCode(h.reseedCalls[0].code);
    expect(code.ok && { host: code.code.host, port: code.code.port, machine: code.code.machine, repl: code.code.repl.user }).toEqual({ host: 'copy.example', port: 5434, machine: 'copy.example', repl: 'replicator' });
    expect(logs).toContain("[Switch] A: copy.example is the main now (generation 4); rebuilding this machine's database as its copy after a dump of it");
  });
  it('J2: another certificate: no rejoin, rejoinError J-FP', async () => {
    h.cert = { ok: false, kind: 'fingerprint', reason: 'fingerprint 0123456789abcdef...', text: 'x' };
    await switchTick(now);
    expect(h.reseedCalls).toEqual([]);
    expect(stored('a').fleetDb.handover.rejoinError).toBe("copy.example shows another certificate than the one it registered (fingerprint 0123456789abcdef...), so this machine did not rejoin it. Copy copy.example's join code and paste it into Rejoin as a copy.");
  });
  it('J3: the composed login refused: J-LOGIN', async () => {
    h.peer = () => ({ kind: 'login-refused', reason: 'password authentication failed' }) as any;
    await switchTick(now);
    expect(stored('a').fleetDb.handover.rejoinError).toBe("copy.example refused this machine's replication login (password authentication failed). Copy copy.example's join code and paste it into Rejoin as a copy.");
  });
  it.each([
    ['J4 unreachable', () => ({ kind: 'unreachable', reason: 'connection timed out' }), 'connection timed out'],
    ['J5 in recovery', () => ({ kind: 'in-recovery', systemId: '7001', timeline: 1, gen: null }), 'copy.example still follows another database'],
  ])('%s: nothing; the wait line names the last check', async (_n, p, reason) => {
    h.peer = p as any;
    await switchTick(now);
    expect(h.reseedCalls).toEqual([]);
    expect(switchView(stored('a')).lines[0]).toBe(`Handed over to copy.example on 2026-10-30 09:00 UTC. This machine rejoins as its copy once copy.example is the main; last check: ${reason}.`);
  });
  it('J6: the re-seed refuses: rejoinError, tried again after 30 minutes', async () => {
    h.peer = writable(4);
    h.reseed = { success: false, error: 'the volume is busy' };
    await switchTick(now);
    expect(stored('a').fleetDb.handover.rejoinError).toBe('Rejoining copy.example as a copy did not start: the volume is busy. The manager tries again in 30 minutes, or press Rejoin as a copy.');
    await switchTick(now + 6 * 60_000);
    expect(h.reseedCalls).toHaveLength(1);
    await switchTick(now + 31 * 60_000);
    expect(h.reseedCalls).toHaveLength(2);
  });
  it('J8: the operator Rejoin of a replaced main composes the code from replacedBy', () => {
    writeRegistry({ a: mainFixture({ fleetDb: { ...(mainFixture().fleetDb as object), replacedBy: { machine: 'copy.example', host: 'copy.example', port: 5434, generation: 5, own: 4, since: null, at: 'x', cert: COPY_PEM } } }) });
    expect(rejoinComposed('a')).toMatchObject({ success: true });
    const code = decodeJoinCode(h.reseedCalls[0].code);
    expect(code.ok && code.code.host).toBe('copy.example');
  });
  it('J10: a target with no address never starts; the J-ALONE line', async () => {
    const { host: _h, port: _p, cert: _c, ...alone } = MARK;
    handedOver(alone);
    await switchTick(now);
    expect(h.reseedCalls).toEqual([]);
    expect(switchView(stored('a')).lines[0]).toBe('Handed over to copy.example, which has no address for other machines, so this machine cannot rejoin it as a copy. Its database stays stopped; decommission it, or move the main back here with Push from copy.example.');
  });
});

describe('J13, J14: Rejoin composed from a tie, and from the old main kept (round 1)', () => {
  it('J13: mainConflict and no replacedBy: the code is composed from the conflict', () => {
    writeRegistry({ a: mainFixture({ fleetDb: { ...(mainFixture().fleetDb as object), mainConflict: { machine: 'b.example', host: 'b.example', port: 5440, generation: 3, at: 'x', cert: COPY_PEM } } }) });
    expect(rejoinComposed('a')).toMatchObject({ success: true });
    const code = decodeJoinCode(h.reseedCalls[0].code);
    expect(code.ok && { host: code.code.host, port: code.code.port, machine: code.code.machine }).toEqual({ host: 'b.example', port: 5440, machine: 'b.example' });
  });
  it("J14: the target's host and port are formerMain's: the code is formerMain.code itself, on a main without replication", () => {
    const former = fakeJoinCode({ host: 'old.example', port: 5500, machine: 'old.example', fp: COPY_FP });
    writeRegistry({ a: mainFixture({ fleetDb: {
      containerName: 'a-pg', user: 'app', db: 'app', volume: 'a-pgdata',
      formerMain: { code: former, slot: 'slot_c', machine: 'old.example', host: 'old.example', port: 5500, generation: 3, at: 'x' },
      replacedBy: { machine: 'old.example', host: 'old.example', port: 5500, generation: 5, own: 4, since: null, at: 'x', cert: COPY_PEM },
    } }) });
    expect(rejoinComposed('a')).toMatchObject({ success: true });
    expect(h.reseedCalls[0].code).toBe(former);
  });
  it.each([
    ['a recorded certificate of another fingerprint', fakeJoinCode({ host: 'old.example', port: 5500, machine: 'old.example' })],
    ['a code that does not decode', ''],
  ])("J15 (D56): the target at formerMain's host and port with %s: composed from the recorded certificate", (_n, former) => {
    writeRegistry({ a: mainFixture({ fleetDb: {
      ...(mainFixture().fleetDb as object),
      formerMain: { code: former, slot: 'slot_c', machine: 'old.example', host: 'old.example', port: 5500, generation: 3, at: 'x' },
      replacedBy: { machine: 'old.example', host: 'old.example', port: 5500, generation: 5, own: 4, since: null, at: 'x', cert: COPY_PEM },
    } }) });
    expect(rejoinComposed('a')).toMatchObject({ success: true });
    const code = decodeJoinCode(h.reseedCalls[0].code);
    expect(code.ok && { host: code.code.host, port: code.code.port, fp: code.code.fp, repl: code.code.repl.user }).toEqual({ host: 'old.example', port: 5500, fp: COPY_FP, repl: 'replicator' });
    expect(h.reseedCalls[0].code).not.toBe(former);
  });
  it("J16 (D64): the target is writable at the mark's generation, and its cluster holds a receive mark: no rejoin, J-RECEIVING", async () => {
    handedOver();
    h.peer = writable(4, '7001', true);
    await switchTick(now);
    expect(h.reseedCalls).toEqual([]);
    expect(stored('a').fleetDb.handover.lastCheck).toBe('copy.example is receiving a push from another machine, or holds one that did not finish');
    expect(switchView(stored('a')).lines[0]).toContain('last check: copy.example is receiving a push from another machine, or holds one that did not finish.');
  });
  it('J17 (D64): the mark read failed: no rejoin, J-MARKUNREAD', async () => {
    handedOver();
    h.peer = writable(4, '7001', null);
    await switchTick(now);
    expect(h.reseedCalls).toEqual([]);
    expect(stored('a').fleetDb.handover.lastCheck).toBe("the manager can't confirm whether copy.example is receiving a push (its receive mark did not read)");
  });
  it("J18 (D64): no mark, and the target's row names another machine than the hand-over's: the rejoin starts", async () => {
    handedOver();
    h.peer = writable(4, '7001', false, 'win.local');
    await switchTick(now);
    expect(h.reseedCalls).toHaveLength(1);
  });
});
