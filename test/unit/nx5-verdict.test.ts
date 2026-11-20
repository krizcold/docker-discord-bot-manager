// NX5 test 12: the lanes' verdict. saveVerdict over rows (pure), the save-order 'stopped' answers under the owner's
// ruling (2026-11-16, "refuse": no "Hand over anyway?" for an unconfirmed save), and the hand-over lane with it.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const tmp = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nx5-verdict-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return { dir, rows: null as null | Record<string, unknown>, readFail: null as null | string, reads: 0 };
});

vi.mock('child_process', async (o) => {
  const real = await o<typeof import('child_process')>();
  const base = (await import('./switch-harness')).childProcessMock(real) as any;
  const { answerSql, fake, switchSpawn } = await import('./switch-fake');
  const { EventEmitter } = await import('events');
  const { PassThrough } = await import('stream');
  const spawn = (cmd: string, args: string[], opts?: any) => {
    if (cmd !== 'docker' || args[0] !== 'exec' || !args.includes('psql') || args.includes('127.0.0.1')) return switchSpawn(cmd, args, opts);
    const entry = { args, input: '' };
    fake.calls.push(entry);
    const c: any = new EventEmitter();
    c.stdout = new PassThrough(); c.stderr = new PassThrough(); c.stdin = new PassThrough(); c.kill = () => true;
    let input = '';
    c.stdin.on('data', (b: Buffer) => { input += b.toString(); });
    c.stdin.on('finish', () => {
      const sql = input || args[args.indexOf('-c') + 1] || '';
      entry.input = sql;
      const container = args[args.indexOf('psql') - 1];
      const db = args[args.indexOf('-d') + 1];
      let a: { code: number; stdout: string; stderr: string };
      if (sql.includes('-- nx5:read')) {
        tmp.reads++;
        a = tmp.readFail ? { code: 1, stdout: '', stderr: tmp.readFail } : { code: 0, stdout: `${JSON.stringify(tmp.rows)}\n`, stderr: '' };
      } else a = answerSql(container, db, sql);
      setTimeout(() => { c.stdout.end(a.stdout); c.stderr.end(a.stderr); setTimeout(() => c.emit('close', a.code), 1); }, 1);
    });
    return c;
  };
  return { ...base, spawn, default: { ...base.default, spawn } };
});
vi.mock('../../src/instance/switchSql', async (o) => ({ ...(await o<any>()), SAVE_READ_SQL: '-- nx5:read\n' }));
vi.mock('../../src/instance/dbLogin', async (o) => (await import('./switch-harness')).dbLoginMock(await o()));
vi.mock('../../src/instance/maintenance', async (o) => (await import('./switch-harness')).maintenanceMock(await o()));
vi.mock('../../src/docker/containerManager', async (o) => (await import('./switch-harness')).containerManagerMock(await o()));
vi.mock('../../src/instance/fleetBackup', async (o) => (await import('./switch-harness')).fleetBackupMock(await o()));
vi.mock('../../src/instance/fleetJoin', async (o) => (await import('./switch-harness')).fleetJoinMock(await o()));
vi.mock('../../src/instance/fleetReplica', async (o) => (await import('./switch-harness')).fleetReplicaMock(await o()));
vi.mock('../../src/instance/appHookClient', async (o) => (await import('./switch-harness')).appHookMock(await o()));
vi.mock('../../src/instance/backupCheck', async (o) => (await import('./switch-harness')).backupCheckMock(await o()));
vi.mock('../../src/env/manager', async (o) => (await import('./switch-harness')).envMock(await o()));
vi.mock('../../src/config/appCapabilities', async (o) => {
  const m = (await import('./switch-harness')).capsMock(await o()) as any;
  return { ...m, findAppCapabilities: (u: string) => { const c = m.findAppCapabilities(u); return { ...c, companionDb: { ...c.companionDb, ...((globalThis as any).__nx5NoSave ? {} : { saveOrder: true }) } }; } };
});

import * as fs from 'fs';
import * as fleetSwitch from '../../src/instance/fleetSwitch';
import { handOver, heldVerdict, resetSwitchState, switchTick, SWITCH_TIMING } from '../../src/instance/fleetSwitch';
import { clearBlockedAt } from '../../src/instance/maintenance';
import { releaseFleetBackupBusy } from '../../src/instance/fleetBackupGuards';
import { COPY_PEM, fake, h, mainFixture, resetHarness, scripts, seedDbs, SETTLED, stored, writeRegistry } from './switch-harness';
import { TX } from './nx5-texts-kit';

const saveVerdict = (fleetSwitch as any).saveVerdict as (rows: unknown, record: unknown, noun: string, mode: string | null) => { go: true } | { refuse: string };

afterAll(() => fs.rmSync(tmp.dir, { recursive: true, force: true }));

const ZERO = { unsavedGuilds: 0, unsavedFiles: 0, unansweredGuilds: 0, unconfirmedFiles: 0, unansweredFiles: 0 };
const ORDER = { id: 'X', state: 'maintenance', message: 'm', current: true, reason: 'order', upMs: 100_000 };
const rowsOf = (over: Record<string, unknown> = {}) => ({
  order: { ...ORDER }, claims: true, expected: [{ process: 'p1', name: 'host-a', agoMs: 4000 }], notSeen: [],
  acks: [{ process: 'p1', order: 'X', saved: true, ...ZERO }], ...over,
});
const FLEET = { orderId: 'X', generation: 3, upMs: 100_000, askedBlocked: false, blockedAt: '2026-11-16T10:00:05.000Z', orderFor: '2026-11-16T10:00:00.000Z', verdict: { kind: 'confirmed' } };
const recordOf = (fleet: Record<string, unknown> | null = FLEET) => ({ ...SETTLED, orderedAt: '2026-11-16T10:00:00.000Z', ...(fleet ? { fleet } : {}) });
const refusalOf = (v: { go: true } | { refuse: string }) => ('refuse' in v ? v.refuse : null);

describe('saveVerdict (decision 6)', () => {
  it('goes when every expected process answered true for the recorded order under the block', () => {
    expect(saveVerdict(rowsOf(), recordOf(), 'hand-over', null)).toEqual({ go: true });
  });
  it.each(['hand-over', 'push', 'move'])('uncovered: the %s is refused naming the machine', (noun) => {
    expect(refusalOf(saveVerdict(rowsOf({ acks: [] }), recordOf(), noun, null))).toBe(TX.laneUncovered(noun, 'host-a'));
  });
  it('no fleet in the record', () => {
    expect(refusalOf(saveVerdict(rowsOf(), recordOf(null), 'hand-over', null))).toBe(TX.laneNoFleet('hand-over'));
  });
  it.each([
    ['another id', { order: { ...ORDER, id: 'Y' } }],
    ['a void row', { order: { ...ORDER, current: false } }],
    ["a 'running' row with the recorded id and an empty expected set", { order: { ...ORDER, state: 'running' }, expected: [], acks: [] }],
    ['no row', { order: null }],
  ])('the row is not this order\'s: %s', (_n, over) => {
    const text = refusalOf(saveVerdict(rowsOf(over), recordOf(), 'hand-over', null));
    expect(text?.startsWith(TX.lane('hand-over'))).toBe(true);
    expect(text).toContain(TX.laneReplaced);
  });
  it.each([['open'], ['blocked']])("orderError with login '%s': could not ask", (login) => {
    const fleet = { ...FLEET, orderId: undefined, orderError: { reason: 'ERROR:  disk full', login } };
    expect(refusalOf(saveVerdict(rowsOf(), recordOf(fleet), 'hand-over', null))).toBe(TX.laneCouldNotAsk('hand-over', 'ERROR:  disk full'));
  });
  it("orderError with login 'unread': can't confirm it asked", () => {
    const fleet = { ...FLEET, orderId: undefined, orderError: { reason: "it could not read the bot's database login: x", login: 'unread' } };
    expect(refusalOf(saveVerdict(rowsOf(), recordOf(fleet), 'push', null))).toBe(TX.laneUnread('push', 'x'));
  });
  it('blockedAt missing', () => {
    const { blockedAt: _b, ...fleet } = FLEET;
    expect(refusalOf(saveVerdict(rowsOf(), recordOf(fleet), 'hand-over', null))).toBe(TX.laneOpened('hand-over'));
  });
  it.each([
    ['with an empty expected set', { expected: [], acks: [] }],
    ['with every expected process covered', {}],
  ])('asked blocked refuses %s', (_n, over) => {
    expect(refusalOf(saveVerdict(rowsOf(over), recordOf({ ...FLEET, askedBlocked: true }), 'hand-over', null))).toContain(TX.askedBlocked.split('. Choose')[0]);
  });
  it("asked blocked goes when the row's reason is 'restore'", () => {
    expect(saveVerdict(rowsOf({ order: { ...ORDER, reason: 'restore' }, acks: [] }), recordOf({ ...FLEET, askedBlocked: true }), 'hand-over', null)).toEqual({ go: true });
  });
  it("can't confirm: no claim tables", () => {
    expect(refusalOf(saveVerdict(rowsOf({ claims: false, expected: [], acks: [] }), recordOf(), 'move', null))).toContain(TX.cant(TX.noTables, TX.once).split(' Choose')[0]);
  });
  it("can't confirm: up_ms NULL", () => {
    expect(refusalOf(saveVerdict(rowsOf({ order: { ...ORDER, upMs: null }, expected: [], acks: [] }), recordOf(), 'move', null))).toContain("The manager can't confirm which bot processes use this database");
  });
  it("reason 'restore' with the recorded id goes, also after a restore in a maintenance whose record had no fleet", () => {
    expect(saveVerdict(rowsOf({ order: { ...ORDER, reason: 'restore' }, acks: [] }), recordOf(), 'hand-over', null)).toEqual({ go: true });
    expect(saveVerdict(rowsOf({ order: { ...ORDER, reason: 'restore' }, acks: [] }), recordOf({ orderId: 'X', blockedAt: '2026-11-16T11:00:00.000Z' }), 'hand-over', null)).toEqual({ go: true });
  });
  it('an answer of saved false refuses with the counts and the Running ending', () => {
    const text = refusalOf(saveVerdict(rowsOf({ acks: [{ process: 'p1', order: 'X', saved: false, ...ZERO, unsavedGuilds: 2, unsavedFiles: 1 }] }), recordOf(), 'hand-over', null));
    expect(text).toContain('The bot on host-a reports changes it could not save (2 guild(s), 1 file(s))');
    expect(text?.endsWith(TX.countsEnd('host-a'))).toBe(true);
  });
  it('review 2 finding 4: an answer of saved false with NULL counts refuses saying the bot could not count them, never 0', () => {
    const text = refusalOf(saveVerdict(rowsOf({ acks: [{ process: 'p1', order: 'X', saved: false, ...ZERO, unsavedGuilds: null, unsavedFiles: 3 }] }), recordOf(), 'push', null));
    expect(text).toContain('The bot on host-a reports changes it could not save (the bot could not count them), so the push was refused');
    expect(text).not.toContain('guild(s)');
  });
  it('an expected process covered only by an answer to another order is uncovered', () => {
    expect(refusalOf(saveVerdict(rowsOf({ acks: [{ process: 'p1', order: 'W', saved: true, ...ZERO }] }), recordOf(), 'hand-over', null))).toBe(TX.laneUncovered('hand-over', 'host-a'));
  });
});

describe('the cancel endings (round 6 minor 3)', () => {
  const plain = 'Choose Running, then Maintenance again';
  it.each([
    ['a hand-over pressed again', 'hand-over', 'stream', TX.cancel('hand-over')],
    ['a push pressed again', 'push', 'push', TX.cancel('push')],
    ['a move by file', 'move', null, plain],
    ['a first press', 'hand-over', null, plain],
  ] as const)('%s', (_n, noun, mode, ending) => {
    const cases: Array<[unknown, unknown]> = [
      [rowsOf({ acks: [] }), recordOf()],
      [rowsOf(), recordOf(null)],
      [rowsOf(), recordOf({ ...FLEET, askedBlocked: true })],
      [rowsOf({ claims: false, expected: [], acks: [] }), recordOf()],
      [rowsOf(), recordOf({ ...FLEET, blockedAt: undefined })],
    ];
    for (const [rows, record] of cases) {
      const text = refusalOf(saveVerdict(rows, record, noun, mode)) ?? '';
      expect(text).toContain(ending);
      if (ending !== plain) expect(text).not.toContain(`. ${plain}`);
    }
  });
});

describe("the save-order 'stopped' answer (J2, L3, G7-3, the owner's 'refuse')", () => {
  const stopped = (before: unknown, shut: boolean) => ({ state: 'stopped', ...(before ? { before } : {}), shut }) as any;
  const verdict = (held: unknown, confirm = false, reason = 'no answer within 30 seconds', saveOrder = true) => (heldVerdict as any)(held, confirm, 'hand-over', reason, saveOrder);
  it.each([false, true])('with shut true and no before: refused (confirm %s), worded from the hook\'s outcome, lost at that stop', (confirm) => {
    const v = verdict(stopped(null, true), confirm);
    expect(v.refuse).toBeDefined();
    expect(v.refuse).toContain("This machine's bot was stopped before it confirmed that it saved what it held");
    expect(v.refuse).toContain('no answer within 30 seconds');
    expect(v.refuse).toContain('lost at that stop');
    expect(v.refuse).not.toContain('anyway?');
    expect(v.refuse).toContain('Choose Running, then Maintenance again');
  });
  it('a hook that answered with a refusal is never called unanswered (G7-3)', () => {
    const v = verdict(stopped(null, true), false, 'the bot answered: busy');
    expect(v.refuse).toContain('the bot answered: busy');
    expect(v.refuse).not.toContain('before it answered the hook');
  });
  it("with shut true and before 'no': those changes were lost at that stop", () => {
    const v = verdict(stopped({ state: 'no', guilds: 2, files: 1 }, true));
    expect(v.refuse).toContain("This machine's bot reported changes it could not save (2 guild(s), 1 file(s)), then it was stopped with its login blocked, so those changes were lost at that stop, not by this hand-over, which loses nothing more. Its log names them.");
  });
  it("with shut true and before 'unknown': can't confirm whether anything was lost", () => {
    const v = verdict(stopped({ state: 'unknown' }, true));
    expect(v.refuse).toContain("This machine's bot answered that it can't confirm every change it held was saved, then it was stopped with its login blocked, so the manager can't confirm whether anything was lost at that stop. This hand-over loses nothing more.");
  });
  it.each([
    ['no before', null, "the manager can't confirm whether anything was lost at that stop. This hand-over loses nothing more."],
    ["before 'no'", { state: 'no', guilds: 2, files: 1 }, "the manager can't confirm whether they were lost at that stop. Its log names them. This hand-over loses nothing more."],
    ["before 'unknown'", { state: 'unknown' }, "the manager can't confirm whether anything was lost at that stop. This hand-over loses nothing more."],
  ])('with shut false and %s: the exit drain may have saved, and no claim that changes were lost at that stop (G8-2)', (_n, before, cant) => {
    const v = verdict(stopped(before, false));
    expect(v.refuse).toContain('before the manager confirmed that its database login was blocked with no session open');
    expect(v.refuse).toContain('exit drain may have saved');
    expect(v.refuse).toContain(cant);
    expect(v.refuse.replace(/can't confirm whether (anything was|they were) lost at that stop/g, '')).not.toMatch(/lost at that stop/);
    expect(v.refuse).not.toContain('anyway?');
    expect(v.refuse).toContain('Choose Running, then Maintenance again');
  });
  it.each([
    ['no before', null],
    ["before 'no'", { state: 'no', guilds: 2, files: 1 }],
    ["before 'unknown'", { state: 'unknown' }],
  ])('guard: an app without the save order keeps today\'s ask (%s)', (_n, before) => {
    expect(verdict(stopped(before, true), false, 'x', false)).toEqual({ ask: 'The bot was stopped without confirming that it saved what it held. Whatever it had not saved was lost at that stop, not by this hand-over, which loses nothing more. Hand over anyway?' });
  });
});

describe('the hand-over lane with the save order', () => {
  beforeEach(() => {
    resetHarness();
    seedDbs();
    tmp.rows = rowsOf();
    tmp.readFail = null;
    tmp.reads = 0;
    writeRegistry({ a: mainFixture({ maintenance: { ...SETTLED, orderedAt: '2026-11-16T10:00:00.000Z', fleet: { ...FLEET } } }) });
    SWITCH_TIMING.catchUpMs = 60;
    SWITCH_TIMING.pollMs = 5;
    releaseFleetBackupBusy('a');
  });
  const handoverRow = () => scripts('a-pg').filter(s => s.includes('INSERT INTO smdb_manager.handover'));
  it('uncovered: refused before any change, no hand-over row', async () => {
    tmp.rows = rowsOf({ acks: [] });
    const r = await handOver('a', 'slot_c', false);
    expect(r).toMatchObject({ success: false, text: TX.laneUncovered('hand-over', 'host-a') });
    expect(handoverRow()).toEqual([]);
    expect(tmp.reads).toBe(1);
  });
  it('the lane read fails: the read text, nothing changed', async () => {
    tmp.readFail = 'ERROR:  canceling statement due to statement timeout';
    const r = await handOver('a', 'slot_c', false);
    expect(r).toMatchObject({ success: false, text: TX.laneRead('hand-over', 'ERROR:  canceling statement due to statement timeout') });
    expect(handoverRow()).toEqual([]);
  });
  it('saveVerdict goes and the own hook answer of no refuses by heldVerdict', async () => {
    h.proof = { ok: true, state: 'maintenance', enforcement: 'database', botConfirmed: true, held: { state: 'no', guilds: 1, files: 0 } };
    const r = await handOver('a', 'slot_c', false);
    expect(tmp.reads).toBe(1);
    expect(r.success).toBe(false);
    expect(r.text).toContain('The bot reports changes it could not save (1 guild(s), 0 file(s))');
    expect(handoverRow()).toEqual([]);
  });
  it('a hand-over pressed again with the mark set ends with the cancel way out', async () => {
    tmp.rows = rowsOf({ acks: [] });
    writeRegistry({ a: mainFixture({ maintenance: { ...SETTLED, orderedAt: '2026-11-16T10:00:00.000Z', fleet: { ...FLEET } }, fleetDb: { ...(mainFixture().fleetDb as object), handover: { mode: 'stream', slot: 'slot_c', machine: 'copy.example', generation: 4, phase: 'waiting', at: '2026-11-16T10:10:00.000Z' } } }) });
    const r = await handOver('a', 'slot_c', false);
    expect(r.success).toBe(false);
    expect(r.text).toContain(TX.cancel('hand-over'));
  });
  it('the undo for a login found open ends "Choose Running, then Maintenance again, then hand over." for a save-order app', async () => {
    h.login = [{ inRecovery: false, canLogin: true, sessions: 0 }];
    const r = await handOver('a', 'slot_c', false);
    expect(r.success).toBe(false);
    expect(r.text).toContain("The bot's database login read open during the hand-over");
    expect(r.text.endsWith('Choose Running, then Maintenance again, then hand over.')).toBe(true);
  });
  const OPEN = { inRecovery: false, canLogin: true, sessions: 0 };
  const BLOCKED = { inRecovery: false, canLogin: false, sessions: 0 };
  const OPENED_CANCEL = "The hand-over was refused and nothing was changed: the bot's login was open after the bots confirmed (a migration ran, or the login was opened outside this manager). Cancel the hand-over, then choose Running, then Maintenance again.";
  it("the reviewer's sequence: the login reads open during the wait and the copy has not confirmed the row's delete; the reconciler's block-again drops blockedAt; Hand over again is refused with the blockedAt-missing cause and the cancel ending", async () => {
    fake.dbs['a-pg'].deleteLsn = '0/5000010';
    h.login = OPEN;
    const first = await handOver('a', 'slot_c', false);
    expect(first.success).toBe(false);
    expect(first.text).toContain('has not confirmed that it dropped it');
    expect(stored('a').fleetDb.handover).toMatchObject({ mode: 'stream', slot: 'slot_c', phase: 'waiting' });
    clearBlockedAt('a');
    expect(stored('a').maintenance.fleet.blockedAt).toBeUndefined();
    h.login = BLOCKED;
    const before = handoverRow().length;
    const r = await handOver('a', 'slot_c', false);
    expect(r).toMatchObject({ success: false, text: OPENED_CANCEL });
    expect(tmp.reads).toBe(2);
    expect(handoverRow()).toHaveLength(before);
  });
  it('a tie: keepBlocked finds the login opened outside the manager, blocks it again and drops blockedAt; after the tie ends Hand over is refused with the blockedAt-missing cause', async () => {
    resetSwitchState();
    const C = { machine: 'copy.example', host: 'copy.example', port: 5434, generation: 3, at: '2026-11-16T10:20:00.000Z', cert: COPY_PEM };
    writeRegistry({ a: mainFixture({ maintenance: { ...SETTLED, orderedAt: '2026-11-16T10:00:00.000Z', fleet: { ...FLEET } }, fleetDb: { ...(mainFixture().fleetDb as object), mainConflict: C } }) });
    const now = Date.parse('2026-11-16T12:00:00Z');
    h.login = OPEN;
    await switchTick(now);
    expect(h.events).toContain('block');
    expect(stored('a').maintenance.fleet.blockedAt).toBeUndefined();
    expect(stored('a').maintenance.fleet.orderId).toBe('X');
    h.login = BLOCKED;
    fake.dbs['a-pg'].addresses = [{ host: 'copy.example', port: 5434, slot: 'fleet_standby_cccccccccccccccccccccccccccccccc', machine: 'copy.example', cert: COPY_PEM }];
    h.peer = () => ({ kind: 'in-recovery', systemId: '7001', timeline: 2, gen: null }) as any;
    await switchTick(now + SWITCH_TIMING.peerEveryMs);
    expect(stored('a').fleetDb.mainConflict).toBeUndefined();
    const r = await handOver('a', 'slot_c', false);
    expect(r).toMatchObject({ success: false, text: TX.laneOpened('hand-over') });
    expect(handoverRow()).toEqual([]);
  });
  it('guard: without the save order the undo keeps today\'s ending', async () => {
    (globalThis as any).__nx5NoSave = true;
    try {
      h.login = [{ inRecovery: false, canLogin: true, sessions: 0 }];
      const r = await handOver('a', 'slot_c', false);
      expect(r.text.endsWith('Choose Maintenance again, then hand over.')).toBe(true);
      expect(tmp.reads).toBe(0);
    } finally {
      delete (globalThis as any).__nx5NoSave;
    }
  });
});
