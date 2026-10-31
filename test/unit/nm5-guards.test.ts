import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm5-guards-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return { dir, snapshots: [] as any[], composeUps: 0, present: new Set<string>(), fenceReads: 0, sidecarUp: false, removed: 0 };
});

const fail = (stderr: string): Error => Object.assign(new Error(stderr), { stderr });
const answer = (args: string[]): string => {
  const line = args.join(' ');
  if (line.startsWith('image inspect') && h.present.has(args[args.length - 1])) return '[{}]';
  if (line.startsWith('image inspect')) throw fail('Error: No such image: x');
  if (line.startsWith('volume inspect')) throw fail('Error: No such volume: x');
  if (line.startsWith('volume rm')) throw fail('Error: No such volume: x');
  return '';
};

vi.mock('child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('child_process')>();
  const execFileSync = (_f: string, args: string[]) => answer(args);
  const execFile = (_f: string, args: string[], opts: any, cb?: any) => {
    const done = typeof opts === 'function' ? opts : cb;
    try { done(null, { stdout: answer(args), stderr: '' }); } catch (e) { done(e); }
  };
  const execSync = () => '';
  const exec = (cmd: string, opts: any, cb?: any) => {
    const done = typeof opts === 'function' ? opts : cb;
    if (cmd.startsWith('docker inspect')) done(new Error('Error: No such object'));
    else if (cmd.startsWith('docker rm')) done(new Error('Error: No such container'));
    else done(null, { stdout: '', stderr: '' });
  };
  const mod = { ...real, exec, execFile, execFileSync, execSync };
  return { ...mod, default: mod };
});
vi.mock('fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('fs')>();
  const mod = {
    ...real,
    renameSync: (a: any, b: any) => {
      if (String(b).endsWith('instances.json')) h.snapshots.push(JSON.parse(real.readFileSync(a, 'utf-8')).instances?.b1);
      return real.renameSync(a, b);
    },
  };
  return { ...mod, default: mod };
});
vi.mock('../../src/casaos/detector', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/casaos/detector')>()),
  getDeploymentMode: async () => 'docker',
}));
vi.mock('../../src/docker/dockerClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/docker/dockerClient')>()),
  pullImage: async () => {},
  composeUp: async () => { h.composeUps++; },
  removeImage: async () => { h.removed++; },
  verifyComposeProjectRunning: async () => ({ allRunning: true, problems: [] }),
  listBotContainers: async () => [],
}));
vi.mock('../../src/webui/server', () => ({ broadcastToClients: () => {} }));
vi.mock('../../src/instance/dbLogin', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/instance/dbLogin')>()),
  sidecarRunning: async () => h.sidecarUp,
  readWriteFence: async () => { h.fenceReads++; return { ok: true, on: true, owner: null, persisted: true }; },
  readBotLogin: async () => ({ ok: true, login: { inRecovery: false, canLogin: false, sessions: 0 } }),
}));

import * as fs from 'fs';
import * as path from 'path';
import * as containerManager from '../../src/docker/containerManager';

const botDir = path.join(h.dir, 'bots', 'b1');
const composePath = path.join(botDir, 'docker-compose.yml');
const stored = (): any => JSON.parse(fs.readFileSync(path.join(h.dir, 'instances.json'), 'utf-8')).instances.b1;

const seed = (extra: Record<string, unknown> = {}): void => {
  fs.writeFileSync(path.join(h.dir, 'instances.json'), JSON.stringify({
    instances: {
      b1: {
        id: 'b1', sanitizedName: 'bot1', displayName: 'Bot 1', titleName: 'Bot 1', status: 'stopped',
        sourceType: 'docker-image', imageRef: 'img:1', envVars: {}, lastBuiltCommit: null,
        createdAt: '2026-10-22T00:00:00.000Z', updatedAt: '2026-10-22T00:00:00.000Z',
        ...extra,
      },
    },
  }));
};

beforeEach(() => {
  h.snapshots.length = 0;
  h.composeUps = 0;
  h.removed = 0;
  h.present.clear();
  fs.rmSync(path.join(h.dir, 'bots'), { recursive: true, force: true });
  fs.mkdirSync(path.join(botDir, 'env'), { recursive: true });
  seed();
});

afterAll(() => {
  fs.rmSync(h.dir, { recursive: true, force: true });
});

import * as maintenance from '../../src/instance/maintenance';

const DB = { containerName: 'bot1-postgres', user: 'app', db: 'app', volume: 'bot1-pgdata' };
const HANDOVER = { mode: 'stream', phase: 'stopped', slot: 'slot_c', machine: 'copy.example', generation: 4, at: '2026-10-30T10:00:00.000Z' };
const REPLACED = { machine: 'copy.example', host: 'copy.example', port: 5434, generation: 5, own: 4, since: null, at: '2026-10-30T10:00:00.000Z' };
const RECEIVE = { startedAt: '2026-10-30T10:00:00.000Z', expiresAt: '2026-10-31T10:00:00.000Z', safetyDump: 'pre-receive-x.dump' };
const MAINT = { state: 'maintenance', message: '', orderedAt: '2026-10-30T00:00:00.000Z', settled: true, hook: 'confirmed', login: 'blocked', savedByBot: 'maintenance' };
const NOTICE = { file: 'old.dump', text: 'Restore of old.dump failed', at: '2026-10-30T09:00:00.000Z', doubt: true };
const withMark = (mark: Record<string, unknown>, extra: Record<string, unknown> = {}) => seed({ fleetDb: { ...DB, ...mark }, maintenance: MAINT, ...extra });
const R15H = 'This machine handed its main database to copy.example (a hand-over to copy.example), so its state cannot change until it rejoins as a copy or the move is cancelled; nothing was changed';
const R15R = 'copy.example replaced this database as the main, so Running would start the bot on an old database. Rejoin this machine as a copy; nothing was changed';
const SW_REPLACED = 'copy.example replaced this database as the main, so the bot does not start here; rejoin it as a copy';
const UPDATE_TAIL = '; the update was refused before the bot was stopped';
const CONFLICT = { machine: 'copy.example', host: 'copy.example', port: 5434, generation: 4, at: '2026-10-30T10:00:00.000Z' };
const PUSHBROKEN = { at: '2026-10-30T10:00:00.000Z', safetyDump: 'pre-receive-x.dump' };
const SW_TWOMAINS = 'Two databases of this bot are mains with the same generation, so the bot does not start here; keep this machine as the main, or rejoin it as a copy';
const SW_PUSHBROKEN = 'A push replaced this database and did not finish, so the bot does not start here; restore the dump pre-receive-x.dump, or receive a push again';

describe('G1 to G3, G9, G10: R15 in the State window, before R13 and R13_FENCE', () => {
  it.each(['running', 'maintenance', 'off'] as const)('G1: %s while a hand-over stands: R15-H', async to => {
    withMark({ handover: HANDOVER });
    const r = await maintenance.runMaintenanceOrder('b1', to, '');
    expect(r.text).toBe(R15H);
    expect(stored().maintenance).toEqual(MAINT);
  });
  it('G2: Running while replacedBy stands: R15-R; Maintenance and Off are admitted past R15 (G15)', async () => {
    withMark({ replacedBy: REPLACED });
    expect((await maintenance.runMaintenanceOrder('b1', 'running', '')).text).toBe(R15R);
  });
  it('G3: Running while receiving: R15-V', async () => {
    withMark({ receive: RECEIVE });
    expect((await maintenance.runMaintenanceOrder('b1', 'running', '')).text).toBe('This database is waiting to receive a main from another machine; choose Running after the push, or Stop receiving first; nothing was changed');
  });
  it('G9: Running with replacedBy and a restore notice: R15-R, not R13', async () => {
    withMark({ replacedBy: REPLACED }, { fleetRestoreError: NOTICE });
    expect((await maintenance.runMaintenanceOrder('b1', 'running', '')).text).toBe(R15R);
  });
  it('G10: any order with a hand-over under the read-only layer: R15-H and no fence read', async () => {
    withMark({ handover: HANDOVER });
    h.fenceReads = 0;
    expect((await maintenance.runMaintenanceOrder('b1', 'running', '')).text).toBe(R15H);
    expect(h.fenceReads).toBe(0);
  });
});

describe('G4 to G6, G11, G12: the start choke points', () => {
  it('G4: Start with a hand-over: SW-START, nothing deployed', async () => {
    withMark({ handover: HANDOVER }, { maintenance: undefined });
    const r = await containerManager.startBot('b1');
    expect(r).toEqual({ success: false, error: 'This machine handed its main database to copy.example, so the bot does not start here; rejoin it as a copy, or cancel the move' });
    expect(h.composeUps).toBe(0);
  });
  it('G5: Start with replacedBy: SW-REPLACED', async () => {
    withMark({ replacedBy: REPLACED }, { maintenance: undefined });
    expect(containerManager.startPreflightRefusal('b1')).toEqual({ success: false, error: SW_REPLACED });
  });
  it('G6: the database alone with a hand-over and no override: SW-DB', async () => {
    withMark({ handover: HANDOVER });
    const r = await containerManager.startFleetDbSidecar('b1');
    expect(r).toEqual({ success: false, error: 'This machine handed its main database to copy.example; the database stays stopped until it rejoins as a copy or the hand-over is cancelled' });
  });
  it('G11: Restart of a running bot with replacedBy: refused before the stop', async () => {
    withMark({ replacedBy: REPLACED }, { status: 'running', maintenance: undefined });
    fs.writeFileSync(composePath, 'services:\n  app:\n    image: img:1\n');
    const r = await containerManager.restartBot('b1');
    expect(r).toEqual({ success: false, error: SW_REPLACED });
    expect(h.snapshots.filter(s => s?.status === 'stopped')).toEqual([]);
    expect(h.composeUps).toBe(0);
  });
  it('G12: Update of a running bot with replacedBy: refused before the stop (SW-REPLACED + UPDATE-TAIL); no stop, no image removal', async () => {
    withMark({ replacedBy: REPLACED }, { status: 'running', maintenance: undefined });
    fs.writeFileSync(composePath, 'services:\n  app:\n    image: img:1\n');
    h.present.add('img:1');
    const r = await containerManager.pullAndRebuild('b1');
    expect(r).toEqual({ success: false, error: `${SW_REPLACED}${UPDATE_TAIL}` });
    expect(h.snapshots.filter(s => s?.status === 'stopped')).toEqual([]);
    expect(h.removed).toBe(0);
    expect(h.composeUps).toBe(0);
  });
});

describe('G7: the reconciler sets no D-LOGIN drift under a switch mark', () => {
  const RUNNING = { state: 'running', message: '', orderedAt: '2026-10-30T00:00:00.000Z', settled: true, hook: 'confirmed', login: 'open', savedByBot: 'running' };
  const D_LOGIN = "The bot's database login is blocked, but its state is Running, so every process of this bot answers with the maintenance message. Choose Running in State to restore the login.";
  beforeEach(() => { maintenance.resetMaintenanceState(); h.sidecarUp = true; });
  afterAll(() => { h.sidecarUp = false; });
  it.each([
    ['handover', { handover: HANDOVER }],
    ['replacedBy', { replacedBy: REPLACED }],
    ['receive', { receive: RECEIVE }],
    ['mainConflict', { mainConflict: CONFLICT }],
    ['pushBroken', { pushBroken: PUSHBROKEN }],
  ])('a blocked login under %s: no drift', async (_n, mark) => {
    seed({ fleetDb: { ...DB, ...mark }, maintenance: RUNNING, envVars: { DATA_BACKEND: 'postgres' }, sourceUrl: 'https://github.com/krizcold/fully-modular-discord-bot' });
    await maintenance.reconcileMaintenance();
    expect(maintenance.getMaintenanceDrift('b1')).toBeNull();
  });
  it('the same login with no mark: D-LOGIN', async () => {
    seed({ fleetDb: { ...DB }, maintenance: RUNNING, envVars: { DATA_BACKEND: 'postgres' }, sourceUrl: 'https://github.com/krizcold/fully-modular-discord-bot' });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await maintenance.reconcileMaintenance();
    warn.mockRestore();
    expect(maintenance.getMaintenanceDrift('b1')).toBe(D_LOGIN);
  });
});

describe('G13: the app service is unless-stopped, so a stop survives a daemon or host restart', () => {
  it.each(['generateCompose', 'generateImageCompose'] as const)('%s', async (name) => {
    const YAML = await import('yaml');
    const compose = await import('../../src/templates/compose');
    const bot = { id: 'b1', sanitizedName: 'bot1', displayName: 'Bot 1', imageRef: 'img:1', envVars: {} } as any;
    const text = name === 'generateCompose'
      ? compose.generateCompose(bot, { type: 'node', databases: [], needsLavalink: false } as any, '/tmp/x', 'img')
      : compose.generateImageCompose(bot, '/tmp/x');
    const doc = YAML.parse(text);
    const app = Object.values(doc.services as Record<string, { restart?: string; container_name?: string }>).find(s => s.container_name === 'bot-b1-app');
    expect(app?.restart).toBe('unless-stopped');
  });
});

describe('G16 to G21: two mains and an unfinished push refuse Running and every start; Update refuses before its stop (D44, D42, D48)', () => {
  it.each([
    ['G16', { mainConflict: CONFLICT }, 'Two databases of this bot are mains with the same generation, so Running would let the bot write to one of them before you choose. Keep this machine as the main, or rejoin it as a copy; nothing was changed'],
    ['G18', { pushBroken: PUSHBROKEN }, 'A push replaced this database and did not finish, so Running would start the bot on an empty or unchecked database. Restore the dump pre-receive-x.dump, or receive a push again; nothing was changed'],
  ])('%s: Running refused, nothing changed', async (_id, mark, text) => {
    withMark(mark);
    const r = await maintenance.runMaintenanceOrder('b1', 'running', '');
    expect(r.text).toBe(text);
    expect(stored().maintenance).toEqual(MAINT);
  });
  it.each([
    ['G17', { mainConflict: CONFLICT }, SW_TWOMAINS],
    ['G19', { pushBroken: PUSHBROKEN }, SW_PUSHBROKEN],
  ])('%s: Start, Restart and Update of a running bot refused before any stop', async (_id, mark, text) => {
    withMark(mark, { maintenance: undefined });
    expect(containerManager.startPreflightRefusal('b1')).toEqual({ success: false, error: text });
    withMark(mark, { status: 'running', maintenance: undefined });
    fs.writeFileSync(composePath, 'services:\n  app:\n    image: img:1\n');
    h.present.add('img:1');
    expect(await containerManager.restartBot('b1')).toEqual({ success: false, error: text });
    expect(await containerManager.pullAndRebuild('b1')).toEqual({ success: false, error: `${text}${UPDATE_TAIL}` });
    expect(h.snapshots.filter(s => s?.status === 'stopped')).toEqual([]);
    expect(h.removed).toBe(0);
    expect(h.composeUps).toBe(0);
  });
  it('G21: Update of a running bot under a hand-over mark: SW-START + UPDATE-TAIL before the stop', async () => {
    withMark({ handover: HANDOVER }, { status: 'running', maintenance: undefined });
    fs.writeFileSync(composePath, 'services:\n  app:\n    image: img:1\n');
    h.present.add('img:1');
    expect(await containerManager.pullAndRebuild('b1')).toEqual({ success: false, error: `This machine handed its main database to copy.example, so the bot does not start here; rejoin it as a copy, or cancel the move${UPDATE_TAIL}` });
    expect(h.snapshots.filter(s => s?.status === 'stopped')).toEqual([]);
    expect(h.removed).toBe(0);
  });
  it('a stopped bot under a mark is updated without a start (nothing to refuse)', async () => {
    withMark({ pushBroken: PUSHBROKEN }, { maintenance: undefined });
    fs.writeFileSync(composePath, 'services:\n  app:\n    image: img:1\n');
    const r = await containerManager.pullAndRebuild('b1');
    expect(r.error ?? '').not.toContain(UPDATE_TAIL);
    expect(h.composeUps).toBe(0);
  });
});
