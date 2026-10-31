import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

// The addresses hook's texts and records, the tick's repeat of a pending offer, and the address list parser.
const tmp = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm5-l5-i-addr-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return { dir, env: {} as Record<string, string> };
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
    markPendingApplyIfRunning: async () => undefined,
    updateInstanceAddressesPush: (id: string, rec: unknown) => {
      if (h.failSwitchWrite) throw new Error(h.failSwitchWrite);
      return real.updateInstanceAddressesPush(id, rec as any);
    },
  };
});
vi.mock('../../src/env/manager', async (o) => ({
  ...(await o<typeof import('../../src/env/manager')>()),
  getEnvVars: () => ({ ...tmp.env }),
  getEnvVarsWithStatus: () => ({ vars: { ...tmp.env }, corrupt: false, undecryptable: [] }),
  setEnvVars: (_id: string, vars: Record<string, string>) => { Object.assign(tmp.env, vars); },
}));

import * as fs from 'fs';
import { isMoveCode } from '../../src/config/joinCode';
import { addressesLogText, addressesState, parseAddressRows, retryAddresses, sendAddresses } from '../../src/instance/fleetJoin';
import { resetSwitchState } from '../../src/instance/fleetSwitch';
import { fakeJoinRecord, FIXTURE_PEM, h, resetHarness, stored, writeRegistry } from './switch-harness';

const URL1 = 'postgresql://app:secretpw@a.example:5432/app?sslmode=verify-full';
const calls = () => h.hookCalls.filter(c => c.action === 'addresses');
const answer = (r: Record<string, unknown>) => { h.hook = () => r as any; };
const PENDING = { ok: false, status: 502, unknown: true, error: 'not ready' };
let warn: ReturnType<typeof vi.spyOn>;
let log: ReturnType<typeof vi.spyOn>;
let err: ReturnType<typeof vi.spyOn>;
const lines = (s: ReturnType<typeof vi.spyOn>) => s.mock.calls.map((c: unknown[]) => String(c[0])).filter((l: string) => l.startsWith('[Switch]'));

beforeEach(() => {
  vi.restoreAllMocks();
  resetHarness();
  resetSwitchState();
  tmp.env = { DATABASE_URL: URL1 };
  writeRegistry({ c: { fleetJoin: fakeJoinRecord() } });
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterAll(() => { vi.restoreAllMocks(); fs.rmSync(tmp.dir, { recursive: true, force: true }); });

describe('the outcome texts', () => {
  it('a 400 or a 500 with no error names no reason given', () => {
    expect(addressesState({ ok: false, status: 400 })).toEqual({ state: 'refused', error: 'no reason given' });
    expect(addressesState({ ok: false, status: 500 })).toEqual({ state: 'pending', error: 'no reason given' });
  });
  it('the log words for unsupported, pending and not running', () => {
    expect(addressesLogText({ state: 'unsupported' })).toBe('has no hook for a new database list');
    expect(addressesLogText({ state: 'pending', error: 'x' })).toBe('did not confirm the new database list (x); the manager sends it again every minute');
    expect(addressesLogText({ state: 'not-running' })).toBe('is not running');
  });
});

describe('sendAddresses', () => {
  it('an applied answer with nothing recorded before writes no record', async () => {
    answer({ ok: true, status: 200 });
    h.failSwitchWrite = 'EACCES';
    expect(await sendAddresses('c')).toEqual({ state: 'applied' });
    expect(err).not.toHaveBeenCalled();
  });
  it('the env value is sent trimmed', async () => {
    tmp.env = { DATABASE_URL: `  ${URL1} ` };
    await sendAddresses('c');
    expect(calls()).toEqual([{ action: 'addresses', body: { url: URL1 } }]);
  });
  it('a missing env value is sent as an empty string', async () => {
    tmp.env = {};
    await sendAddresses('c');
    expect(calls()).toEqual([{ action: 'addresses', body: { url: '' } }]);
  });
});

describe('retryAddresses', () => {
  const pending = async () => { answer(PENDING); await sendAddresses('c'); expect(stored('c').addressesPush).toMatchObject({ state: 'pending' }); };
  it('an env value with spaces around it is the one offered: sent again', async () => {
    tmp.env = { DATABASE_URL: ` ${URL1}  ` };
    await pending();
    await retryAddresses('c');
    expect(calls()).toHaveLength(2);
  });
  it('a missing env value offered as empty: sent again', async () => {
    tmp.env = {};
    await pending();
    await retryAddresses('c');
    expect(calls()).toHaveLength(2);
  });
  it('the app container stopped: the pending record is dropped, nothing sent', async () => {
    await pending();
    h.app = false;
    await retryAddresses('c');
    expect(calls()).toHaveLength(1);
    expect(stored('c').addressesPush).toBeUndefined();
  });
  it('the container state unknown: no line is logged', async () => {
    await pending();
    h.app = null;
    await retryAddresses('c');
    expect([...lines(warn), ...lines(log)]).toEqual([]);
  });
  it('still pending: no line is logged', async () => {
    await pending();
    await retryAddresses('c');
    expect(calls()).toHaveLength(2);
    expect([...lines(warn), ...lines(log)]).toEqual([]);
  });
  it('refused on the repeat: a warning, not a log line', async () => {
    await pending();
    answer({ ok: false, status: 400, error: 'bad list' });
    await retryAddresses('c');
    expect(lines(warn)).toEqual(['[Switch] C: the running bot refused the new database list (bad list)']);
    expect(lines(log)).toEqual([]);
  });
});

describe('parseAddressRows', () => {
  const row = { host: 'main.invalid', port: 15432, slot: null, cert: FIXTURE_PEM, machine: 'm' };
  it('a leading byte order mark is trimmed off', () => {
    expect(parseAddressRows(`﻿${JSON.stringify([row])}`)).toHaveLength(1);
  });
  it('a malformed row is left out', () => {
    expect(parseAddressRows(JSON.stringify([{ host: 1 }, row]))).toEqual([{ host: 'main.invalid', port: 15432, slot: null, cert: FIXTURE_PEM.trim(), machine: 'm' }]);
  });
});

describe('isMoveCode', () => {
  it('a move code with spaces before it', () => {
    expect(isMoveCode('  smdbmove1.abc')).toBe(true);
  });
});
