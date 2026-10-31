import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm8-keys-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return { dir, failAlertWrites: false };
});

vi.mock('child_process', async (importOriginal) => (await import('./join-fake')).childProcessMock(await importOriginal<typeof import('child_process')>()));
vi.mock('../../src/casaos/detector', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/casaos/detector')>()),
  getDeploymentMode: async () => 'docker',
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
    deployedComposeExists: () => true,
    appContainerRunning: async () => true,
    markPendingApplyIfRunning: async () => undefined,
    applyFleetDbReplicaService: async () => ({ success: true }),
    updateInstanceFleetBackupAlert: (id: string, key: string, alert: any) => {
      if (h.failAlertWrites) throw new Error('disk full');
      return real.updateInstanceFleetBackupAlert(id, key, alert);
    },
    updateInstanceFleetCopyAlert: (id: string, key: string, alert: any) => {
      if (h.failAlertWrites) throw new Error('disk full');
      return real.updateInstanceFleetCopyAlert(id, key, alert);
    },
  };
});

import * as fs from 'fs';
import * as path from 'path';
import { fakeJoinRecord, resetDocker } from './join-fake';

const SMDB = 'https://example.invalid/fake/super-modular-discord-bot';
const REGISTRY = path.join(h.dir, 'instances.json');
const NOW = Date.UTC(2026, 9, 31, 10, 0);
const H = 3_600_000;
const REPLICA = {
  containerName: 'b-fleet-postgres-replica', volume: 'b-fleet-postgres-replica-data', slot: 'fleet_standby_b',
  primaryHost: 'main.invalid', primaryPort: 15432, publicHost: 'copy.invalid', hostPort: 15433, certHost: 'copy.invalid',
  user: 'smdb', db: 'smdb', seededAt: 1, seededBy: 5,
};
const builtSeed = {
  purpose: 'reseed-standby', phase: 'starting', startedAt: 5, updatedAt: 5, primaryHost: 'main.invalid', primaryPort: 15432,
  slot: 'fleet_standby_b', committed: true, auto: true, rebuildCause: 'slot', safetyDump: 'copy-pre-rebuild-x.dump',
};
const writeRegistry = (over: Record<string, unknown> = {}, id = 'b') => fs.writeFileSync(REGISTRY, JSON.stringify({ instances: { [id]: {
  id, sanitizedName: 'b', displayName: 'B', titleName: 'B', status: 'running', sourceType: 'git', sourceUrl: SMDB, updateToken: 'tok',
  envVars: { DATA_BACKEND: 'postgres' }, createdAt: '2026-10-24T00:00:00.000Z', updatedAt: '2026-10-24T00:00:00.000Z', ...over,
} } }, null, 2));
const stored = (id = 'b'): any => JSON.parse(fs.readFileSync(REGISTRY, 'utf-8')).instances[id];

type Answer = { status: number; body: Record<string, unknown> } | 'hang';
let bodies: any[] = [];
let answer: Answer = { status: 200, body: { success: true, posted: true, place: 'dm' } };
let onCall: (() => void) | null = null;

async function fresh() {
  vi.resetModules();
  const cm = await import('../../src/docker/containerManager');
  const bc = await import('../../src/instance/backupCheck');
  const cw = await import('../../src/instance/fleetCopyWatch');
  const fr = await import('../../src/instance/fleetReplica');
  const bf = await import('../../src/instance/backupFiles');
  bc.alertTiming.hookTimeoutMs = 40;
  return { cm, bc, cw, fr, bf };
}

const pageHtml = fs.readFileSync(path.resolve(__dirname, '../../src/webui/public/index.html'), 'utf8');
const pageFn = (name: string): string => {
  const start = pageHtml.indexOf(`function ${name}(`);
  expect(start, name).toBeGreaterThan(-1);
  return pageHtml.slice(start, pageHtml.indexOf('\n    }\n', start) + 6);
};
const pageAlertLine = (a: unknown) => require('vm').runInNewContext(`${['backupTime', 'backupAlertHtml'].map(pageFn).join('\n')}\nbackupAlertHtml(a)`, { escapeHtml: (s: string) => `[${s}]`, a }) as string;

const quiet = () => (['log', 'warn', 'error'] as const).forEach(k => vi.spyOn(console, k).mockImplementation(() => {}));

beforeEach(() => {
  resetDocker();
  h.failAlertWrites = false;
  bodies = [];
  onCall = null;
  answer = { status: 200, body: { success: true, posted: true, place: 'dm' } };
  quiet();
  vi.stubGlobal('fetch', async (_url: string, init: any) => {
    bodies.push(JSON.parse(init.body));
    onCall?.();
    if (answer === 'hang') return new Promise((_res, rej) => init.signal.addEventListener('abort', () => rej(init.signal.reason)));
    return new Response(JSON.stringify(answer.body), { status: answer.status });
  });
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
afterAll(() => { fs.rmSync(h.dir, { recursive: true, force: true }); });

describe('NM8 keys: a restart between the send and its record resends the same key', () => {
  it('K1 the backup and test restore alerts (NM2)', async () => {
    writeRegistry();
    let m = await fresh();
    onCall = () => { h.failAlertWrites = true; };
    await m.bc.stepAlerts(m.cm.getBot('b')!, [{ family: 'main', kind: 'test', on: true, text: 'The test restore failed' }], NOW);
    expect(stored().fleetBackupAlerts['main:test']).toMatchObject({ since: NOW, dm: 'pending' });
    h.failAlertWrites = false;
    onCall = null;
    m = await fresh();
    await m.bc.stepAlerts(m.cm.getBot('b')!, [{ family: 'main', kind: 'test', on: true, text: 'The test restore failed' }], NOW + H);
    expect(bodies).toHaveLength(2);
    expect(bodies[0].key).toBe(`b:backup-main-test:${NOW}`);
    expect(bodies[1].key).toBe(bodies[0].key);
    expect(bodies[0].text).toBe('The test restore failed');
  });

  it('K1b the dumps alert of the copy family names its own case', async () => {
    writeRegistry();
    const m = await fresh();
    await m.bc.stepAlerts(m.cm.getBot('b')!, [{ family: 'copy', kind: 'dumps', on: true, text: 'No backup' }], NOW);
    expect(bodies[0].key).toBe(`b:backup-copy-dumps:${NOW}`);
  });

  it('K2 the copy watch messages (NM3)', async () => {
    writeRegistry({ fleetJoin: fakeJoinRecord() });
    let m = await fresh();
    onCall = () => { h.failAlertWrites = true; };
    await m.cw.stepCopyAlerts(m.cm.getBot('b')!, { held: { on: true, text: 'The copy is held' }, stopped: null }, NOW);
    expect(stored().fleetCopyAlerts.held).toMatchObject({ since: NOW, dm: 'pending' });
    h.failAlertWrites = false;
    onCall = null;
    answer = { status: 200, body: { success: true, posted: false, note: 'This message was already posted on 2026-10-31.' } };
    m = await fresh();
    await m.cw.stepCopyAlerts(m.cm.getBot('b')!, { held: { on: true, text: 'The copy is held' }, stopped: null }, NOW + H);
    expect(bodies).toHaveLength(2);
    expect(bodies[0].key).toBe(`b:copy-held:${NOW}`);
    expect(bodies[1].key).toBe(bodies[0].key);
    expect(stored().fleetCopyAlerts.held).toMatchObject({ dm: 'sent', dmRepeat: true, dmNote: 'This message was already posted on 2026-10-31.' });
  });

  it('K3 the finished rebuild (T-38), stored at boot through the real writer', async () => {
    writeRegistry({ fleetJoin: fakeJoinRecord(), fleetDbReplica: REPLICA, fleetDbReplicaSeed: builtSeed });
    let m = await fresh();
    await m.fr.parkInterruptedReplicaSeeds();
    expect(stored().fleetCopyAlerts.rebuilt).toMatchObject({ since: 5, dm: 'pending' });
    onCall = () => { h.failAlertWrites = true; };
    await m.fr.sendRebuiltAlert('b', NOW);
    expect(stored().fleetCopyAlerts.rebuilt.dm).toBe('pending');
    h.failAlertWrites = false;
    onCall = null;
    m = await fresh();
    await m.fr.sendRebuiltAlert('b', NOW + 1000);
    expect(bodies).toHaveLength(2);
    expect(bodies[0].key).toBe('b:copy-rebuilt:5');
    expect(bodies[1].key).toBe(bodies[0].key);
    expect(stored().fleetCopyAlerts.rebuilt).toMatchObject({ dm: 'sent', dmPlace: 'dm' });
  });

  it('K4 a key is at most 200 characters', async () => {
    const id = 'x'.repeat(250);
    writeRegistry({}, id);
    const m = await fresh();
    await m.bc.stepAlerts(m.cm.getBot(id)!, [{ family: 'main', kind: 'test', on: true, text: 't' }], NOW);
    expect(bodies[0].key.length).toBe(200);
  });
});

describe('NM8 outcomes: what the bot answered is kept and shown', () => {
  const step = async (m: Awaited<ReturnType<typeof fresh>>) =>
    m.bc.stepAlerts(m.cm.getBot('b')!, [{ family: 'main', kind: 'test', on: true, text: 'failed' }], NOW);

  it('O1 a post to the owner messages channel', async () => {
    writeRegistry();
    answer = { status: 200, body: { success: true, posted: true, place: 'channel' } };
    const m = await fresh();
    await step(m);
    const a = stored().fleetBackupAlerts['main:test'];
    expect(a).toMatchObject({ dm: 'sent', dmPlace: 'channel' });
    expect(m.bf.dmOutcomeText(a)).toBe('The owner was sent a Discord message in the owner messages channel.');
  });

  it('O2 a post by DM with a note', async () => {
    writeRegistry();
    answer = { status: 200, body: { success: true, posted: true, place: 'dm', note: 'The channel setting could not be read, so the message went to the DMs.' } };
    const m = await fresh();
    await step(m);
    const a = stored().fleetBackupAlerts['main:test'];
    expect(m.bf.dmOutcomeText(a)).toBe("The owner was sent a Discord message by DM. The bot's note: The channel setting could not be read, so the message went to the DMs.");
  });

  it('O4 a key already posted counts as delivered and is not sent again', async () => {
    writeRegistry();
    answer = { status: 200, body: { success: true, posted: false, note: 'Already posted.' } };
    const m = await fresh();
    await step(m);
    const a = stored().fleetBackupAlerts['main:test'];
    expect(a).toMatchObject({ dm: 'sent', dmRepeat: true, dmNote: 'Already posted.' });
    expect(a.dmPlace).toBeUndefined();
    expect(m.bf.dmOutcomeText(a)).toBe("The bot had already posted this message, so it posted nothing new. The bot's note: Already posted.");
    await m.bc.stepAlerts(m.cm.getBot('b')!, [{ family: 'main', kind: 'test', on: true, text: 'failed' }], NOW + 5 * H);
    expect(bodies).toHaveLength(1);
  });

  it('O6 a 502 unknown is can\'t confirm with the bot\'s error', async () => {
    writeRegistry();
    answer = { status: 502, body: { success: false, unknown: true, error: 'Discord did not answer within 20 s' } };
    const m = await fresh();
    await step(m);
    const a = stored().fleetBackupAlerts['main:test'];
    expect(a).toMatchObject({ dm: 'unknown', dmError: 'Discord did not answer within 20 s' });
    expect(m.bf.dmOutcomeText(a)).toBe("Whether the owner was messaged can't be confirmed: Discord did not answer within 20 s.");
  });

  it('O6b a send after an unknown keeps no old place or note', async () => {
    writeRegistry({ fleetBackupAlerts: { 'main:test': { kind: 'test', text: 'failed', since: NOW - H, dm: 'failed', dmAt: NOW - 2 * H, dmError: 'x', dmPlace: 'dm', dmNote: 'old' } } });
    answer = { status: 502, body: { success: false, unknown: true, error: 'no answer' } };
    const m = await fresh();
    await step(m);
    const a = stored().fleetBackupAlerts['main:test'];
    expect(a).toEqual({ kind: 'test', text: 'failed', since: NOW - H, dm: 'unknown', dmAt: NOW, dmError: 'no answer' });
    expect(bodies[0].key).toBe(`b:backup-main-test:${NOW - H}`);
  });

  it('O7 when the manager stops waiting: the fixed lines in the Database window and on the panel, no Fleet view or retry', async () => {
    writeRegistry();
    answer = 'hang';
    const m = await fresh();
    await step(m);
    const a = stored().fleetBackupAlerts['main:test'];
    expect(a).toMatchObject({ dm: 'unknown', dmAt: NOW });
    expect(a.dmError).toBeUndefined();
    expect(m.bf.dmOutcomeText(a)).toBe("Whether the owner was messaged can't be confirmed: the bot took the message but did not answer in time.");
    expect(pageAlertLine(a)).toBe("<div class=\"env-tip\">The bot did not answer within 30 s, so the manager can't confirm the owner got the message.</div>");
  });

  it('O7b the copy watch keeps the same fixed line when the manager stops waiting', async () => {
    writeRegistry({ fleetJoin: fakeJoinRecord() });
    answer = 'hang';
    const m = await fresh();
    await m.cw.stepCopyAlerts(m.cm.getBot('b')!, { held: { on: true, text: 'The copy is held' }, stopped: null }, NOW);
    const a = stored().fleetCopyAlerts.held;
    expect(a.dm).toBe('unknown');
    expect(a.dmError).toBeUndefined();
    expect(m.bf.dmOutcomeText(a)).toBe("Whether the owner was messaged can't be confirmed: the bot took the message but did not answer in time.");
  });

  it('O7d the log line gives the fixed reason when the manager stops waiting', async () => {
    writeRegistry();
    answer = 'hang';
    const m = await fresh();
    await step(m);
    const lines = (console.log as any).mock.calls.map((c: unknown[]) => String(c[0])).filter((l: string) => l.startsWith('[FleetBackup] Message to the owner'));
    expect(lines).toEqual(['[FleetBackup] Message to the owner of B about main:test: unknown (the bot did not answer within 30 s)']);
  });

  it("O7e a 503 unknown with a reason keeps the bot's reason in both windows", async () => {
    writeRegistry();
    answer = { status: 503, body: { unknown: true, error: 'x' } };
    const m = await fresh();
    await step(m);
    const a = stored().fleetBackupAlerts['main:test'];
    expect(a).toMatchObject({ dm: 'unknown', dmError: 'x' });
    expect(m.bf.dmOutcomeText(a)).toBe("Whether the owner was messaged can't be confirmed: x.");
    expect(pageAlertLine(a)).toContain('[x]');
  });

  it('O7c a post with no place reads as a Discord message', async () => {
    const { bf } = await fresh();
    expect(bf.dmOutcomeText({ dm: 'sent' })).toBe('The owner was sent a Discord message.');
  });
});

describe('NM8 outcomes on the page: the backup alert lines', () => {
  const pageHtml = fs.readFileSync(path.resolve(__dirname, '../../src/webui/public/index.html'), 'utf8');
  const fn = (name: string): string => {
    const start = pageHtml.indexOf(`function ${name}(`);
    expect(start, name).toBeGreaterThan(-1);
    return pageHtml.slice(start, pageHtml.indexOf('\n    }\n', start) + 6);
  };
  const src = ['backupTime', 'backupAlertHtml'].map(fn).join('\n');
  const line = (a: unknown) => require('vm').runInNewContext(`${src}\nbackupAlertHtml(a)`, { escapeHtml: (s: string) => `[${s}]`, a }) as string;
  const T0 = Date.UTC(2026, 9, 31, 4, 10);
  const when = `[${new Date(T0).toLocaleString()}]`;
  const alert = (over: Record<string, unknown>) => ({ kind: 'test', text: 'x', since: T0, dm: 'sent', dmAt: T0, ...over });

  it.each([
    ['P1', alert({ dmPlace: 'channel' }), `The owner was sent a message in the owner messages channel at ${when}.`],
    ['P2', alert({ dmPlace: 'dm' }), `The owner was sent a DM at ${when}.`],
    ['P2b', alert({}), `The owner was sent a Discord message at ${when}.`],
    ['P3', alert({ dmRepeat: true }), `At ${when} the bot answered that it had already posted this message, so it posted nothing new.`],
    ['P4', alert({ dmPlace: 'dm', dmNote: 'The channel refused.' }), `The owner was sent a DM at ${when}. The bot's note: [The channel refused.]`],
    ['P7', alert({ dm: 'unknown', dmError: 'Discord did not answer within 20 s' }), "The manager can't confirm the owner got the message: [Discord did not answer within 20 s]."],
  ])('%s', (_n, a, text) => {
    expect(line(a)).toBe(`<div class="env-tip">${text}</div>`);
  });
});
