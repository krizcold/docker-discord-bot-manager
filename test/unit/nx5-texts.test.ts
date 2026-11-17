// NX5 test 14: every operator text of decisions 4 to 6 and 11 as the manager renders it with machine names: the
// sheet's words, printable ASCII, no long dash; the can't-confirm text ends with Running then Maintenance; no
// verdict names a 60-second wait; on a replaced main the way out is the rejoin (G7-5).
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/docker/processStart', async (o) => (await import('./nx5-kit')).processStartMock(await o()));
vi.mock('../../src/instance/switchSql', async (o) => (await import('./nx5-kit')).switchSqlMock(await o()));
vi.mock('../../src/env/manager', async (o) => (await import('./nx5-kit')).envMock(await o()));
vi.mock('../../src/config/appCapabilities', async (o) => (await import('./nx5-kit')).capsMock(await o()));
vi.mock('../../src/docker/containerManager', async () => (await import('./nx5-kit')).containerManagerMock());
vi.mock('../../src/instance/dbLogin', async (o) => (await import('./nx5-kit')).dbLoginMock(await o()));
vi.mock('../../src/instance/appHookClient', async (o) => (await import('./nx5-kit')).appHookMock(await o()));
vi.mock('../../src/instance/fleetReplication', async (o) => (await import('./nx5-kit')).fleetReplicationMock(await o()));

import * as fleetSwitch from '../../src/instance/fleetSwitch';
import { MAINTENANCE_TIMING, maintenanceStatus, resetMaintenanceState, runMaintenanceOrder } from '../../src/instance/maintenance';
import { CONTAINER, claim, h, k, resetH, resetKit, settledRec, setupBot, wire } from './nx5-kit';
import { plain, TX } from './nx5-texts-kit';

const T = MAINTENANCE_TIMING as any;
const d = () => k.dbs[CONTAINER];
const BLOCKED = () => ({ inRecovery: false, canLogin: false, sessions: 0 });
const DISK = 'ERROR:  disk full';
const saveVerdict = (fleetSwitch as any).saveVerdict as (rows: unknown, record: unknown, noun: string, mode: string | null) => { go: true } | { refuse: string };

beforeEach(() => {
  resetMaintenanceState();
  resetH();
  resetKit();
  wire();
  setupBot();
  T.ackPollMs = 2;
  T.ackWaitMs = 30;
  MAINTENANCE_TIMING.hookWaitMs = 30;
  MAINTENANCE_TIMING.hookWaitPauseMs = 1;
  MAINTENANCE_TIMING.hookWaitTryMs = 10;
});

const settledX = () => {
  setupBot(settledRec('maintenance', { fleet: { orderId: 'X', generation: 3, upMs: 100_000, askedBlocked: false, blockedAt: '2026-11-16T09:00:00.000Z', orderFor: '2026-10-01T00:00:00.000Z' } }));
  h.db = BLOCKED();
  d().order = { id: 'X', state: 'maintenance', message: 'old', generation: 3, reason: 'order', upMs: 100_000 };
  d().claims = [claim('p1', 'host-a')];
  d().acks = [{ process: 'p1', order: 'X', saved: true }];
};

type Case = [string, () => void, 'maintenance' | 'off', string];
const cases: Case[] = [
  ['all covered', () => { d().claims = [claim('p1', 'host-a'), claim('p2', 'host-b')]; d().autoAck = { p1: { saved: true }, p2: { saved: true } }; }, 'maintenance', TX.covered(2, 'host-a, host-b')],
  ['the empty set, Off', () => {}, 'off', TX.empty('Off')],
  ['not covered', () => { d().claims = [claim('p2', 'host-b', 200_000, { agoMs: 9000 })]; }, 'maintenance', TX.uncovered('host-b', '9 seconds') + TX.update],
  ['answered unsaved', () => { d().claims = [claim('p2', 'host-b')]; d().autoAck = { p2: { saved: false, unsavedGuilds: 1, unsavedFiles: 4 } }; }, 'maintenance', TX.unsaved('host-b', 1, 4)],
  ['answered null', () => { d().claims = [claim('p2', 'host-b')]; d().autoAck = { p2: { saved: null, unansweredGuilds: 2 } }; }, 'maintenance', TX.unconfirmed('host-b', 2)],
  ['not seen, Off', () => { d().claims = [claim('p3', 'host-c', 10_000, { agoMs: 300_000 })]; }, 'off', TX.notSeen('host-c', 'Off', '5 minutes')],
  ['asked blocked', () => { setupBot(settledRec('maintenance')); h.db = BLOCKED(); }, 'maintenance', TX.askedBlocked],
  ["can't confirm, no tables", () => { d().claimTables = false; }, 'maintenance', TX.cant(TX.noTables, TX.once)],
  ['restored', () => { settledX(); d().order!.reason = 'restore'; d().acks = []; }, 'maintenance', TX.restored],
  ['not asked, blocked write', () => { setupBot(settledRec('off', { hook: 'none' })); h.app = false; h.db = BLOCKED(); d().failNext.order = [DISK]; }, 'maintenance', TX.notAskedErr(DISK)],
  ['the message sentence', () => { settledX(); d().failNext.order = [DISK]; }, 'maintenance', TX.msgWrite(DISK)],
  ['the order step for a failed read', () => { h.failPreBlock = 'docker did not answer within 30 s'; }, 'maintenance', TX.orderFail('Maintenance', TX.readReason('docker did not answer within 30 s'))],
  ['the failed final read, Maintenance', () => { setupBot(settledRec('off', { hook: 'none' })); h.app = false; h.db = BLOCKED(); d().failNext.read = ['ERROR:  x']; }, 'maintenance', TX.finalFail('Maintenance', 'ERROR:  x')],
  ['the failed final read, Off', () => { settledX(); d().failNext.read = ['ERROR:  x']; }, 'off', TX.finalFail('Off', 'ERROR:  x')],
];

describe('the settled and unsettled texts of Maintenance and Off', () => {
  it.each(cases)('%s', async (_n, arrange, to, expected) => {
    arrange();
    const r = await runMaintenanceOrder('b1', to, 'msg');
    expect(r.text).toContain(expected);
    expect(plain(r.text)).toBe(true);
    expect(r.text).not.toMatch(/60.second/);
  });
  it("the can't-confirm text ends with Choose Running, then Maintenance again", async () => {
    d().failNext.order = [DISK, DISK];
    await runMaintenanceOrder('b1', 'maintenance', 'msg');
    const r = await runMaintenanceOrder('b1', 'maintenance', '', { retry: true });
    expect(r.text).toContain(TX.cant(TX.notWritten(DISK)));
    expect(TX.cant(TX.notWritten(DISK)).endsWith('Choose Running, then Maintenance again.')).toBe(true);
    expect(plain(r.text)).toBe(true);
  });
  it.each([['maintenance', 'Maintenance'], ['off', 'Off']] as const)('the waiting line for %s', async (state, to) => {
    d().claims = [claim('p1', 'host-a'), claim('p2', 'host-b')];
    T.ackWaitMs = 600;
    const lines: string[] = [];
    k.onRead = async (_db, n) => { if (n === 2) lines.push((await maintenanceStatus(JSON.parse(JSON.stringify(h.inst)), null)).summary); };
    await runMaintenanceOrder('b1', state, 'x');
    expect(lines[0]).toMatch(TX.waiting(to, 'host-a, host-b'));
    expect(plain(lines[0])).toBe(true);
  });
  it('G7-5: on a replaced main the verdict ends with the rejoin, not Running', async () => {
    setupBot(undefined, { fleetDb: { containerName: CONTAINER, user: 'smdb', db: 'smdb', volume: 'v', replacedBy: { machine: 'copy.example', host: 'copy.example', port: 5434, generation: 5, own: 3, since: null, at: '2026-11-16T10:00:00.000Z' } } });
    d().claims = [claim('p2', 'host-b')];
    const r = await runMaintenanceOrder('b1', 'maintenance', 'x');
    expect(r.text).toContain('The bot on host-b did not confirm that it saved what it holds');
    expect(r.text).not.toContain('Choose Running');
    expect(r.text).not.toContain('choose Running');
    expect(r.text).toMatch(/rejoin/i);
  });
});

describe('the lanes\' texts', () => {
  const ZERO = { unsavedGuilds: 0, unsavedFiles: 0, unansweredGuilds: 0, unconfirmedFiles: 0, unansweredFiles: 0 };
  const ORDER = { id: 'X', state: 'maintenance', message: 'm', current: true, reason: 'order', upMs: 100_000 };
  const rows = (over: Record<string, unknown> = {}) => ({ order: ORDER, claims: true, expected: [{ process: 'p1', name: 'host-a', agoMs: 4000 }], notSeen: [], acks: [], ...over });
  const FLEET = { orderId: 'X', askedBlocked: false, blockedAt: '2026-11-16T10:00:05.000Z' };
  const rec = (fleet: Record<string, unknown> | null) => ({ state: 'maintenance', message: 'm', orderedAt: '2026-11-16T10:00:00.000Z', settled: true, hook: 'confirmed', login: 'blocked', savedByBot: 'maintenance', ...(fleet ? { fleet } : {}) });
  it.each([
    ['uncovered', rows(), rec(FLEET), TX.laneUncovered('push', 'host-a')],
    ['no fleet', rows(), rec(null), TX.laneNoFleet('push')],
    ['could not ask', rows(), rec({ ...FLEET, orderId: undefined, orderError: { reason: DISK, login: 'open' } }), TX.laneCouldNotAsk('push', DISK)],
    ['unread', rows(), rec({ ...FLEET, orderId: undefined, orderError: { reason: "it could not read the bot's database login: y", login: 'unread' } }), TX.laneUnread('push', 'y')],
    ['blockedAt missing', rows(), rec({ orderId: 'X', askedBlocked: false }), TX.laneOpened('push')],
    ['counts', rows({ acks: [{ process: 'p1', order: 'X', saved: false, ...ZERO, unsavedGuilds: 3, unsavedFiles: 0 }] }), rec(FLEET), TX.countsEnd('host-a')],
  ])('%s', (_n, r, record, expected) => {
    const v = saveVerdict(r, record, 'push', null);
    const text = 'refuse' in v ? v.refuse : '';
    expect(text).toContain(expected);
    expect(plain(text)).toBe(true);
    expect(text).not.toMatch(/60.second/);
  });
  it('the cancel endings are plain text', () => {
    for (const what of ['hand-over', 'push'] as const) {
      const v = saveVerdict(rows(), rec(FLEET), what, what === 'push' ? 'push' : 'stream');
      const text = 'refuse' in v ? v.refuse : '';
      expect(text).toContain(TX.cancel(what));
      expect(plain(text)).toBe(true);
    }
  });
  it("the six 'stopped' answers are plain text", () => {
    for (const shut of [true, false]) {
      for (const before of [null, { state: 'no', guilds: 1, files: 2 }, { state: 'unknown' }]) {
        const v = (fleetSwitch.heldVerdict as any)({ state: 'stopped', ...(before ? { before } : {}), shut }, false, 'push', 'no answer within 30 seconds', true);
        expect(v.ask).toBeUndefined();
        const text = v.refuse ?? '';
        expect(text.length).toBeGreaterThan(0);
        expect(plain(text)).toBe(true);
      }
    }
  });
});

describe("the sheet's texts themselves", () => {
  it('are printable ASCII with no long dash', () => {
    const all = [
      TX.covered(1, 'a'), TX.empty('Off'), TX.uncovered('a', '3 seconds'), TX.update, TX.unsaved('a', 1, 1), TX.unconfirmed('a', 1), TX.notSeen('a', 'Off', '2 minutes'),
      TX.askedBlocked, TX.cant(TX.noTables, TX.once), TX.restored, TX.notAsked, TX.notAskedErr('e'), TX.unread('e'), TX.msgWrite('e'), TX.msgRead('e'),
      TX.orderFail('Off', 'e'), TX.finalFail('Off', 'e'), TX.laneRead('move', 'e'), TX.stays(TX.staysOrder), TX.stays(TX.staysLogin), TX.stays(TX.staysFile),
      TX.unreadRunning('e'), TX.starting,
    ];
    for (const t of all) expect(plain(t)).toBe(true);
  });
});
