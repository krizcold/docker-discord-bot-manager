import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Contract 3's addresses hook (D31): a new database list offered to the running bot after every lane's write of the
// URL key; the record keeps a digest, never the value, and the tick repeats an unconfirmed offer.
const tmp = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm5-addresses-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return { dir, env: {} as Record<string, string>, recreates: 0, corrupt: false };
});

vi.mock('child_process', async (o) => (await import('./switch-harness')).childProcessMock(await o()));
vi.mock('../../src/instance/dbLogin', async (o) => (await import('./switch-harness')).dbLoginMock(await o()));
vi.mock('../../src/instance/appHookClient', async (o) => (await import('./switch-harness')).appHookMock(await o()));
vi.mock('../../src/config/appCapabilities', async (o) => (await import('./switch-harness')).capsMock(await o()));
vi.mock('../../src/docker/containerManager', async (o) => {
  const real = await o<typeof import('../../src/docker/containerManager')>();
  const { h } = await import('./switch-harness');
  return {
    ...real,
    appContainerRunning: async () => h.app,
    markPendingApplyIfRunning: async () => { tmp.recreates++; },
    updateInstanceAddressesPush: (id: string, rec: unknown) => {
      if (h.failSwitchWrite) throw new Error(h.failSwitchWrite);
      return real.updateInstanceAddressesPush(id, rec as any);
    },
  };
});
vi.mock('../../src/env/manager', async (o) => ({
  ...(await o<typeof import('../../src/env/manager')>()),
  getEnvVars: () => ({ ...tmp.env }),
  getEnvVarsWithStatus: () => ({ vars: { ...tmp.env }, corrupt: tmp.corrupt, undecryptable: [] }),
  setEnvVars: (_id: string, vars: Record<string, string>) => { Object.assign(tmp.env, vars); },
}));

import * as crypto from 'crypto';
import * as fs from 'fs';
import { addressesLogText, addressesText, sendAddresses, writeEnvList } from '../../src/instance/fleetJoin';
import { resetSwitchState, switchTick, switchView } from '../../src/instance/fleetSwitch';
import * as containerManager from '../../src/docker/containerManager';
import { fakeJoinRecord, h, resetHarness, stored, writeRegistry } from './switch-harness';

const URL1 = 'postgresql://app:secretpw@a.example:5432/app?sslmode=verify-full';
const digest = (v: string) => crypto.createHash('sha256').update(v).digest('hex').slice(0, 16);
let now = Date.parse('2026-10-30T10:00:00Z');

beforeEach(() => {
  resetHarness();
  resetSwitchState();
  tmp.env = { DATABASE_URL: URL1 };
  tmp.recreates = 0;
  tmp.corrupt = false;
  writeRegistry({ c: { fleetJoin: fakeJoinRecord() } });
  now += 10 * 60_000;
});
afterAll(() => fs.rmSync(tmp.dir, { recursive: true, force: true }));

const calls = () => h.hookCalls.filter(c => c.action === 'addresses');
const answer = (r: Record<string, unknown>) => { h.hook = () => r as any; };

describe('A1 to A8, A10: one offer and what it records', () => {
  it('A1: applied: the body holds the env value, nothing is recorded, the env value stays', async () => {
    answer({ ok: true, status: 200, body: { success: true, applied: true } });
    expect(await sendAddresses('c')).toEqual({ state: 'applied' });
    expect(calls()).toEqual([{ action: 'addresses', body: { url: URL1 } }]);
    expect(stored('c').addressesPush).toBeUndefined();
    expect(tmp.env.DATABASE_URL).toBe(URL1);
    expect(tmp.recreates).toBe(0);
  });
  it('A2: applied with a note', async () => {
    answer({ ok: true, status: 200, body: { success: true, applied: true, note: 'no bot process runs; the list applies when it starts' } });
    expect(await sendAddresses('c')).toEqual({ state: 'applied', note: 'no bot process runs; the list applies when it starts' });
    expect(stored('c').addressesPush).toBeUndefined();
  });
  it('A3: a 400 is refused, kept with the digest and never the value', async () => {
    answer({ ok: false, status: 400, error: 'the list has no writable entry' });
    expect(await sendAddresses('c')).toEqual({ state: 'refused', error: 'the list has no writable entry' });
    const rec = stored('c').addressesPush;
    expect(rec).toMatchObject({ digest: digest(URL1), state: 'refused', error: 'the list has no writable entry' });
    expect(JSON.stringify(rec)).not.toContain('secretpw');
    expect(switchView(stored('c')).lines).toContain('The bot refused its new database list (the list has no writable entry); it uses the list from its next start (Apply on the card, or Restart).');
  });
  it.each([
    ['A4 502 unknown', { ok: false, status: 502, unknown: true, error: 'Discord login not ready' }],
    ['A5 the manager timeout', { ok: false, unknown: true, error: 'addresses sent, no answer within 10 s; check the app\'s Fleet view before retrying' }],
    ['A6 unreachable', { ok: false, error: 'addresses unreachable: fetch failed' }],
    ['A6 a 500', { ok: false, status: 500, error: 'addresses returned 500' }],
  ])('%s: pending, with the switch view line', async (_n, r) => {
    answer(r);
    expect(await sendAddresses('c')).toEqual({ state: 'pending', error: r.error });
    expect(stored('c').addressesPush).toMatchObject({ digest: digest(URL1), state: 'pending', error: r.error });
    expect(switchView(stored('c')).lines).toContain(`The manager can't confirm that the running bot took its new database list (${r.error}); it sends the list again every minute until the bot answers.`);
  });
  const FILES = 'This bot keeps its data in files, so it has no main database';
  it.each([
    ['Postgres', 'postgres', false, true],
    ['files', 'json', false, false],
    ['unreadable', 'postgres', true, null],
  ] as const)('A7: a 409 with the stored mode %s is files, not recorded and not repeated', async (_n, mode, corrupt, next) => {
    h.capsMode = { key: 'DATA_BACKEND', value: 'postgres' };
    tmp.env.DATA_BACKEND = mode;
    tmp.corrupt = corrupt;
    answer({ ok: false, status: 409, error: FILES });
    expect(await sendAddresses('c')).toEqual({ state: 'files', error: FILES, next });
    expect(stored('c').addressesPush).toBeUndefined();
    expect(switchView(stored('c')).lines.filter(l => l.includes('database list'))).toEqual([]);
    await switchTick(now);
    expect(calls()).toHaveLength(1);
  });
  it('A7: an older pending record is cleared by a 409, and the tick sends nothing', async () => {
    answer({ ok: false, status: 502, unknown: true, error: 'x' });
    await sendAddresses('c');
    expect(stored('c').addressesPush).toMatchObject({ state: 'pending' });
    answer({ ok: false, status: 409, error: FILES });
    expect(await sendAddresses('c')).toMatchObject({ state: 'files' });
    expect(stored('c').addressesPush).toBeUndefined();
    await switchTick(now);
    expect(calls()).toHaveLength(2);
  });
  it.each([
    [true, ` The running bot keeps its data in files, so it uses the new database list from its next start (Apply on the card, or Restart).`],
    [false, ` The bot keeps its data in files, and its settings keep it on files, so it does not use the new database list.`],
    [null, ` The running bot keeps its data in files, and the manager can't read the bot's settings, so it can't confirm whether the bot's next start uses the new database list.`],
  ] as const)('A7: the files text with next %s', (next, want) => {
    expect(addressesText({ state: 'files', error: 'e1', next })).toBe(want);
  });
  it('A7: the files log text', () => {
    expect(addressesLogText({ state: 'files', error: 'e1', next: null })).toBe('keeps its data in files and did not take the new database list');
  });
  it('A7: a 404 is unsupported and not repeated', async () => {
    answer({ ok: false, status: 404, error: 'x' });
    expect(await sendAddresses('c')).toEqual({ state: 'unsupported' });
    expect(stored('c').addressesPush).toMatchObject({ state: 'unsupported' });
    await switchTick(now);
    expect(calls()).toHaveLength(1);
  });
  it.each([false, null])('A8: the app container running is %s: no call, nothing recorded', async app => {
    h.app = app;
    expect(await sendAddresses('c')).toEqual({ state: 'not-running' });
    expect(calls()).toEqual([]);
    expect(stored('c').addressesPush).toBeUndefined();
  });
  it('A10: the record write throws: the outcome still comes back, and the log names it', async () => {
    answer({ ok: false, status: 502, unknown: true, error: 'x' });
    h.failSwitchWrite = 'EACCES: permission denied';
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await sendAddresses('c')).toEqual({ state: 'pending', error: 'x' });
    expect(err.mock.calls.map(c => String(c[0]))).toContain('[Switch] C: the outcome of the database list offer could not be recorded (EACCES: permission denied)');
    err.mockRestore();
  });
});

describe('A9, A11, A13: the tick repeats a pending offer (N-h)', () => {
  it('A4 and A11: repeated every pass while pending; an applied answer clears it, logged once', async () => {
    answer({ ok: false, status: 502, unknown: true, error: 'not ready' });
    await sendAddresses('c');
    await switchTick(now);
    expect(calls()).toHaveLength(2);
    answer({ ok: true, status: 200, body: { success: true, applied: true } });
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await switchTick(now + 60_000);
    await switchTick(now + 120_000);
    const logs = log.mock.calls.map(c => String(c[0]));
    log.mockRestore();
    expect(calls()).toHaveLength(3);
    expect(stored('c').addressesPush).toBeUndefined();
    expect(logs.filter(l => l === '[Switch] C: the running bot took the new database list')).toHaveLength(1);
  });
  it('A11: a repeat refused, or unsupported, is set and logged', async () => {
    answer({ ok: false, status: 502, unknown: true, error: 'not ready' });
    await sendAddresses('c');
    answer({ ok: false, status: 400, error: 'bad list' });
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await switchTick(now);
    const logs = [...log.mock.calls, ...warn.mock.calls].map(c => String(c[0]));
    log.mockRestore();
    warn.mockRestore();
    expect(stored('c').addressesPush).toMatchObject({ state: 'refused', error: 'bad list' });
    expect(logs).toContain('[Switch] C: the running bot refused the new database list (bad list)');
  });
  it('A9: the value changed since: the old pending record is dropped and the old value never sent', async () => {
    answer({ ok: false, status: 502, unknown: true, error: 'not ready' });
    await sendAddresses('c');
    tmp.env.DATABASE_URL = 'postgresql://app:secretpw@b.example:5432/app';
    await switchTick(now);
    expect(calls()).toHaveLength(1);
    expect(stored('c').addressesPush).toBeUndefined();
  });
  it('A13: a busy bot is skipped this pass', async () => {
    answer({ ok: false, status: 502, unknown: true, error: 'not ready' });
    await sendAddresses('c');
    await containerManager.withExternalBotOp('c', 'restore', async () => { await switchTick(now); });
    expect(calls()).toHaveLength(1);
  });
});

describe('A12: the writers offer the list after their env write', () => {
  it('writeEnvList (join, refresh, the hourly rewrite, the copy post-start and removal): the call follows the write, with the new value', async () => {
    tmp.env.DATABASE_URL = 'old';
    answer({ ok: true, status: 200, body: { success: true, applied: true } });
    const r = await writeEnvList('c');
    expect(r.changed).toBe(true);
    expect(r.addresses).toEqual({ state: 'applied' });
    expect(calls()).toEqual([{ action: 'addresses', body: { url: tmp.env.DATABASE_URL } }]);
    expect(tmp.env.DATABASE_URL).not.toBe('old');
  });
  it('writeEnvList with no change sends nothing', async () => {
    tmp.env.DATABASE_URL = 'old';
    await writeEnvList('c');
    await writeEnvList('c');
    expect(calls()).toHaveLength(1);
  });
  it('a failed offer never undoes the write', async () => {
    tmp.env.DATABASE_URL = 'old';
    answer({ ok: false, status: 400, error: 'bad list' });
    const r = await writeEnvList('c');
    expect(r.addresses).toEqual({ state: 'refused', error: 'bad list' });
    expect(tmp.env.DATABASE_URL).not.toBe('old');
  });
});
