import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm2-alerts-'));
  process.env.DATA_DIR = dir;
  return { dir, hooks: true, alertSaveFails: false };
});

vi.mock('child_process', async (importOriginal) => (await import('./nm2-docker')).childProcessMock(await importOriginal()));
vi.mock('../../src/config/appCapabilities', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/config/appCapabilities')>()),
  findAppCapabilities: () => ({ companionDb: { env: { url: 'DATABASE_URL' } }, ...(h.hooks ? { hooks: { port: 3000, basePath: '/api/managed' } } : {}) }),
}));
vi.mock('../../src/templates/pcsProcessing', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/templates/pcsProcessing')>()),
  fleetAppContainerName: () => 'app-1',
}));
vi.mock('../../src/webui/server', () => ({ broadcastToClients: () => {} }));
vi.mock('../../src/docker/containerManager', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/docker/containerManager')>();
  return {
    ...real,
    readDeployedCompose: () => 'compose',
    updateInstanceFleetBackupAlert: (id: string, key: string, alert: any) => {
      if (h.alertSaveFails) throw new Error('disk full');
      return real.updateInstanceFleetBackupAlert(id, key, alert);
    },
  };
});

import * as fs from 'fs';
import { PRIMARY, seedBot, clearRegistry, stored, restartedManager, logged } from './nm2-harness';
import { setNow, realNow } from './nm2-harness';

const NOW = Date.UTC(2026, 9, 27, 10, 30);
const H = 3_600_000;
type Call = { url: string; body: any; dmAtCall: unknown };
let calls: Call[] = [];
let answer: 'ok' | '404' | 'hang' | 'refused' = 'ok';

async function load() {
  await restartedManager();
  const bc = await import('../../src/instance/backupCheck');
  const cm = await import('../../src/docker/containerManager');
  bc.alertTiming.hookTimeoutMs = 40;
  const step = (on: boolean, text = 'Backups failed', now = NOW, kind: 'dumps' | 'test' = 'test') =>
    bc.stepAlerts(cm.getBot('a')!, [{ family: 'main', kind, on, text }], now);
  return { bc, cm, step };
}

beforeEach(() => {
  setNow(NOW);
  h.hooks = true;
  h.alertSaveFails = false;
  calls = [];
  answer = 'ok';
  clearRegistry();
  seedBot({ fleetDb: PRIMARY, updateToken: 'tok', envVars: {} });
  vi.stubGlobal('fetch', async (url: string, init: any) => {
    calls.push({ url, body: JSON.parse(init.body), dmAtCall: stored().fleetBackupAlerts?.['main:test']?.dm });
    if (answer === 'hang') {
      return new Promise((_res, rej) => init.signal.addEventListener('abort', () => rej(init.signal.reason)));
    }
    if (answer === 'refused') throw new TypeError('fetch failed', { cause: new Error('connect ECONNREFUSED') });
    if (answer === '404') return new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
    return new Response(JSON.stringify({ success: true }), { status: 200 });
  });
});
afterEach(() => { realNow(); vi.unstubAllGlobals(); });
afterAll(() => { fs.rmSync(h.dir, { recursive: true, force: true }); });

describe('NM2 C: the alert and its one DM', () => {
  it('C1 a condition that starts is saved pending before the hook is called', async () => {
    const { step } = await load();
    await step(true);
    expect(calls.length).toBe(1);
    expect(calls[0].dmAtCall).toBe('pending');
    expect(calls[0].url).toBe('http://app-1:3000/api/managed/notify-owner');
    expect(calls[0].body).toEqual({ text: 'Backups failed' });
  });

  it('C2 an alert that cannot be saved is held in memory, the DM is still sent, and it is logged', async () => {
    const { bc, step } = await load();
    h.alertSaveFails = true;
    const { lines } = await logged(() => step(true));
    expect(calls.length).toBe(1);
    expect(stored().fleetBackupAlerts).toBeUndefined();
    expect(bc.currentAlerts('a')['main:test']).toMatchObject({ dm: 'sent', text: 'Backups failed' });
    expect(lines.join('\n')).toMatch(/\[FleetBackup\] .*disk full/);
  });

  it('C3 a hook that answers ok marks the alert sent at now', async () => {
    const { step } = await load();
    await step(true);
    expect(stored().fleetBackupAlerts['main:test']).toEqual({ kind: 'test', text: 'Backups failed', since: NOW, dm: 'sent', dmAt: NOW });
  });

  it.each([['404', 'an older bot (404)'], ['refused', 'a bot that is down']])('C4 %s (%s): failed with dmError, tried again after an hour', async (kind) => {
    answer = kind as '404' | 'refused';
    const { step } = await load();
    await step(true);
    const a = stored().fleetBackupAlerts['main:test'];
    expect(a.dm).toBe('failed');
    expect(a.dmError).toMatch(kind === '404' ? /not found/ : /notify-owner unreachable/);
    await step(true, 'Backups failed', NOW + 30 * 60_000);
    expect(calls.length).toBe(1);
    answer = 'ok';
    await step(true, 'Backups failed', NOW + H);
    expect(calls.length).toBe(2);
    expect(stored().fleetBackupAlerts['main:test']).toMatchObject({ dm: 'sent', dmAt: NOW + H });
  });

  it('C5 a hook that does not answer in time leaves the DM unknown and it is not sent again', async () => {
    answer = 'hang';
    const { step } = await load();
    await step(true);
    expect(stored().fleetBackupAlerts['main:test'].dm).toBe('unknown');
    await step(true, 'Backups failed', NOW + 5 * H);
    expect(calls.length).toBe(1);
  });

  it('C6 an app with no hooks: unsupported, and the hook is never called', async () => {
    h.hooks = false;
    const { step } = await load();
    await step(true);
    await step(true, 'Backups failed', NOW + 5 * H);
    expect(stored().fleetBackupAlerts['main:test'].dm).toBe('unsupported');
    expect(calls.length).toBe(0);
  });

  it('C7 a restart between the call and the result write sends the DM again', async () => {
    seedBot({ fleetDb: PRIMARY, updateToken: 'tok', envVars: {}, fleetBackupAlerts: { 'main:test': { kind: 'test', text: 'Backups failed', since: NOW - 60_000, dm: 'pending' } } });
    const { step } = await load();
    await step(true);
    expect(calls.length).toBe(1);
    expect(stored().fleetBackupAlerts['main:test']).toMatchObject({ dm: 'sent', since: NOW - 60_000 });
  });

  it('C8 a standing condition whose text changes updates the text and sends nothing', async () => {
    const { step } = await load();
    await step(true);
    await step(true, 'Backups failed again', NOW + 2 * H);
    expect(calls.length).toBe(1);
    expect(stored().fleetBackupAlerts['main:test'].text).toBe('Backups failed again');
  });

  it('C9 a condition that clears removes the alert with no DM', async () => {
    const { step } = await load();
    await step(true);
    await step(false);
    expect(stored().fleetBackupAlerts?.['main:test']).toBeUndefined();
    expect(calls.length).toBe(1);
  });

  it('C10 a condition that comes back after clearing is a new alert with one DM', async () => {
    const { step } = await load();
    await step(true);
    await step(false);
    await step(true, 'Backups failed', NOW + 10 * 60_000);
    expect(calls.length).toBe(2);
    expect(stored().fleetBackupAlerts['main:test'].since).toBe(NOW + 10 * 60_000);
  });

  it('C11 a family no longer held loses its alerts', async () => {
    const { bc, cm, step } = await load();
    await step(true);
    await bc.stepAlerts(cm.getBot('a')!, [], NOW + 60_000);
    expect(stored().fleetBackupAlerts?.['main:test']).toBeUndefined();
    expect(calls.length).toBe(1);
  });

  it('the DM text is cut to 1500 characters', async () => {
    const { step } = await load();
    await step(true, 'x'.repeat(2000));
    expect(calls[0].body.text.length).toBe(1500);
  });
});
