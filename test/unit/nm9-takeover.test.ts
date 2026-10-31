import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const tmp = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm9-takeover-'));
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
import { SWITCH_TIMING, takeOverMain } from '../../src/instance/fleetSwitch';
import * as containerManager from '../../src/docker/containerManager';
import * as switchSql from '../../src/instance/switchSql';
import { COPY_PEM, copyFixture, fake, freshDb, h, resetHarness, stored, writeRegistry } from './switch-harness';

const CAP: string = (switchSql as any).SHARD_CAP_DO_SQL;

beforeEach(() => {
  resetHarness();
  fake.dbs['c-pg'] = freshDb({ recovery: true, generation: { generation: 3, machine: 'main.invalid', since: '2026-10-28T10:00:00Z' }, handover: { slot: 'slot_c', machine: 'copy.example', generation: 4 }, addresses: [
    { host: 'main.invalid', port: 15432, slot: null, machine: 'main.invalid', cert: COPY_PEM },
    { host: 'copy.example', port: 5434, slot: 'slot_c', machine: 'copy.example', cert: COPY_PEM },
  ], copies: [{ slot: 'slot_c', machine: 'copy.example', client: '10.0.0.2' }] });
  writeRegistry({ c: copyFixture() });
  SWITCH_TIMING.replayWaitMs = 50;
  SWITCH_TIMING.pollMs = 5;
});
afterAll(() => fs.rmSync(tmp.dir, { recursive: true, force: true }));

const markRow = (dbOid: string, pushIds = ['a1']) => { fake.dbs['c-pg'].receiveMark = { markId: pushIds[0], pushIds, dbOid }; };
const promotedCopy = () => {
  h.copyFacts = { ok: true, facts: { inRecovery: false, streaming: false, systemId: '7001', timeline: 2, lsn: 1n } };
  fake.dbs['c-pg'].recovery = false;
  fake.dbs['c-pg'].handover = null;
};
const raises = () => fake.calls.map(c => c.input).filter(i => i.includes('INSERT INTO smdb_manager.generation AS g'));
const count = (text: string, part: string) => text.split(part).length - 1;
/** The take-over intents saved, in order. */
const intents = () => {
  const real = containerManager.updateInstanceFleetDbReplicaTakeover;
  const saved: any[] = [];
  const spy = vi.spyOn(containerManager, 'updateInstanceFleetDbReplicaTakeover').mockImplementation(((id: string, t: any) => {
    saved.push(t);
    return real(id, t);
  }) as any);
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  return { saved, restore: () => { spy.mockRestore(); warn.mockRestore(); } };
};
const capAfterAddresses = (raise: string) => {
  expect(typeof CAP).toBe('string');
  expect(count(raise, CAP)).toBe(1);
  const cap = raise.indexOf(CAP);
  expect(raise.lastIndexOf("IF to_regclass('smdb_manager.addresses') IS NOT NULL THEN")).toBeLessThan(cap);
  expect(raise.slice(cap + CAP.length)).toMatch(/^SELECT generation \|\| /);
};
const STEPS = ['hba-block', 'promote', 'raise', 'hba-lift', 'adopt'];

describe('NM9 a take-over over an unchecked mark caps the shard claims (D18)', () => {
  it('TK1 (H10): T68\'s unplanned take-over with confirmUnchecked: the cap in the raise, the intent saved with unchecked', async () => {
    fake.dbs['c-pg'].handover = null;
    markRow('11111');
    const seen = intents();
    const r = await takeOverMain('c', { confirmUnchecked: true, start: false });
    seen.restore();
    expect(r.success).toBe(true);
    const [raise] = raises();
    capAfterAddresses(raise);
    expect(seen.saved[0]).toMatchObject({ planned: false, generation: 4, unchecked: true });
    expect(h.events.filter(e => STEPS.includes(e))).toEqual(STEPS);
  });

  it('TK2 (H10): T69\'s copy promoted outside the manager: the cap in the raise', async () => {
    promotedCopy();
    markRow('11111');
    const seen = intents();
    const r = await takeOverMain('c', { confirmUnchecked: true, start: false });
    seen.restore();
    expect(r.text).toMatch(/^This machine is the main now \(generation 4/);
    capAfterAddresses(raises()[0]);
    expect(seen.saved[0]).toMatchObject({ unchecked: true });
    expect(h.events.filter(e => STEPS.includes(e))).toEqual(['hba-block', 'raise', 'hba-lift', 'adopt']);
  });

  it('TK3 (H11): the raise fails: NM5\'s text, no lift, the intent kept with unchecked', async () => {
    fake.dbs['c-pg'].handover = null;
    markRow('11111');
    fake.dbs['c-pg'].fail.raise = 'ERROR:  permission denied for table shard_claims';
    const seen = intents();
    const r = await takeOverMain('c', { confirmUnchecked: true, start: false });
    seen.restore();
    expect(r.text).toBe('The copy is promoted, but its generation could not be raised (ERROR:  permission denied for table shard_claims), so bots may not choose it over the old main. Press Take over again to finish.');
    expect(h.events).not.toContain('hba-lift');
    expect(stored('c').fleetDbReplica.takeover).toMatchObject({ unchecked: true });
  });

  it('TK4 (H12): Take over again after TK3 resumes without reading the mark, and the raise holds the cap', async () => {
    fake.dbs['c-pg'].handover = null;
    markRow('11111');
    fake.dbs['c-pg'].fail.raise = 'ERROR:  disk full';
    const seen = intents();
    await takeOverMain('c', { confirmUnchecked: true, start: false });
    delete fake.dbs['c-pg'].fail.raise;
    h.copyFacts = { ok: true, facts: { inRecovery: false, streaming: false, systemId: '7001', timeline: 2, lsn: 1n } };
    h.events.length = 0;
    fake.calls.length = 0;
    const r = await takeOverMain('c', { start: false });
    seen.restore();
    expect(r.success).toBe(true);
    expect(h.events).not.toContain('mark-read');
    capAfterAddresses(raises()[0]);
  });

  it.each([
    ['planned', () => undefined],
    ['unplanned, mark none', () => { fake.dbs['c-pg'].handover = null; }],
    ['unplanned, mark checked', () => { fake.dbs['c-pg'].handover = null; markRow('11111', ['a1']); fake.dbs['c-pg'].received.push({ pushId: 'a1', from: '9', machine: 'win.local', generation: 3 }); }],
    ['unplanned, mark untouched', () => { fake.dbs['c-pg'].handover = null; markRow('16384'); }],
  ] as Array<[string, () => void]>)('TK5 (H14): %s: no cap, no unchecked in the intent', async (_n, set) => {
    set();
    const seen = intents();
    const r = await takeOverMain('c', { confirm: true, start: false });
    seen.restore();
    expect(r.success).toBe(true);
    expect(raises().length).toBeGreaterThan(0);
    for (const raise of raises()) expect(raise).not.toContain('UPDATE smdb_data.shard_claims');
    expect(seen.saved[0]).toBeTruthy();
    expect(seen.saved[0].unchecked).toBeUndefined();
  });
});

describe('NM9 a press that is not a resume caps only by its own mark (D19)', () => {
  const checkedMark = () => { markRow('11111', ['a1']); fake.dbs['c-pg'].received.push({ pushId: 'a1', from: '9', machine: 'win.local', generation: 3 }); };
  const failedFirstPress = async (failure: () => void) => {
    fake.dbs['c-pg'].handover = null;
    markRow('11111');
    failure();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const r1 = await takeOverMain('c', { confirmUnchecked: true, start: false });
    warn.mockRestore();
    expect(r1.success).toBe(false);
    expect(stored('c').fleetDbReplica.takeover).toMatchObject({ unchecked: true });
  };
  const noCap = () => { for (const raise of raises()) expect(raise).not.toContain('UPDATE smdb_data.shard_claims'); };

  it.each([
    ['the promote failed, the mark now checked', () => { fake.dbs['c-pg'].fail.promote = 'ERROR:  promote failed'; }, () => { delete fake.dbs['c-pg'].fail.promote; checkedMark(); }],
    ['the promote failed, the mark now none', () => { fake.dbs['c-pg'].fail.promote = 'ERROR:  promote failed'; }, () => { delete fake.dbs['c-pg'].fail.promote; fake.dbs['c-pg'].receiveMark = null; }],
    ['the login block failed, the mark now checked', () => { fake.dbs['c-pg'].fail['block-script'] = 'permission denied'; }, () => { delete fake.dbs['c-pg'].fail['block-script']; checkedMark(); }],
  ] as Array<[string, () => void, () => void]>)('TK6 (H15): %s: Take over again caps nothing and saves no unchecked', async (_n, failure, after) => {
    await failedFirstPress(failure);
    after();
    fake.calls.length = 0;
    const seen = intents();
    const r = await takeOverMain('c', { confirm: true, start: false });
    seen.restore();
    expect(r.success).toBe(true);
    expect(raises().length).toBeGreaterThan(0);
    noCap();
    expect(seen.saved[0]).toBeTruthy();
    expect(seen.saved[0].unchecked).toBeUndefined();
  });

  it('TK7 (H15 then H12): the second press fails at the raise without the cap, and its resume caps nothing', async () => {
    await failedFirstPress(() => { fake.dbs['c-pg'].fail.promote = 'ERROR:  promote failed'; });
    delete fake.dbs['c-pg'].fail.promote;
    checkedMark();
    fake.dbs['c-pg'].fail.raise = 'ERROR:  disk full';
    fake.calls.length = 0;
    const seen = intents();
    const r2 = await takeOverMain('c', { confirm: true, start: false });
    expect(r2.text).toBe('The copy is promoted, but its generation could not be raised (ERROR:  disk full), so bots may not choose it over the old main. Press Take over again to finish.');
    expect(raises().length).toBeGreaterThan(0);
    noCap();
    delete fake.dbs['c-pg'].fail.raise;
    h.copyFacts = { ok: true, facts: { inRecovery: false, streaming: false, systemId: '7001', timeline: 2, lsn: 1n } };
    h.events.length = 0;
    fake.calls.length = 0;
    const r3 = await takeOverMain('c', { start: false });
    seen.restore();
    expect(r3.success).toBe(true);
    expect(h.events).not.toContain('mark-read');
    expect(raises().length).toBeGreaterThan(0);
    noCap();
  });
});
