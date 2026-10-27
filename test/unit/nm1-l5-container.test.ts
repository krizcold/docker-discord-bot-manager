import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm1-l5-container-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return { dir, shell: [] as string[], notReady: false, notReadyLeft: 0, hang: false, execOpts: [] as any[], ps: null as null | string | Error, deleting: false };
});

const fail = (stderr: string): Error => Object.assign(new Error(stderr), { stderr });
const deleteAnswer = (args: string[]): string => {
  const line = args.join(' ');
  if (line.startsWith('image inspect')) throw fail('Error: No such image: x');
  if (line.startsWith('volume inspect')) throw fail('Error: No such volume: x');
  if (line.startsWith('volume rm')) throw fail('Error: No such volume: x');
  return '';
};

vi.mock('child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('child_process')>();
  const execFile = (_f: string, args: string[], opts: any, cb?: any) => {
    const done = typeof opts === 'function' ? opts : cb;
    if (h.deleting) {
      try { done(null, { stdout: deleteAnswer(args), stderr: '' }); } catch (e) { done(e); }
    } else if (args[0] === 'inspect') setImmediate(() => done(null, 'true\n', ''));
    else setImmediate(() => done(Object.assign(new Error('docker failed'), { code: 1 }), '', 'refused'));
    return { stdin: null };
  };
  const exec = (cmd: string, opts: any, cb?: any) => {
    const done = typeof opts === 'function' ? opts : cb;
    h.shell.push(cmd);
    if (cmd.includes('pg_isready')) h.execOpts.push(typeof opts === 'function' ? undefined : opts);
    if (cmd.startsWith('docker ps -q') && h.ps !== null) {
      if (h.ps instanceof Error) done(h.ps);
      else done(null, { stdout: h.ps, stderr: '' });
    } else if (h.deleting && cmd.startsWith('docker inspect')) done(new Error('Error: No such object'));
    else if (h.deleting && cmd.startsWith('docker rm')) done(new Error('Error: No such container'));
    else if (h.hang && cmd.includes('pg_isready')) {
      if (opts?.timeout) setTimeout(() => done(Object.assign(new Error('killed'), { killed: true })), opts.timeout);
    } else if ((h.notReady || h.notReadyLeft > 0) && cmd.includes('pg_isready')) {
      if (h.notReadyLeft > 0) h.notReadyLeft--;
      done(Object.assign(new Error('the database system is starting up'), { code: 1 }));
    } else done(null, { stdout: '', stderr: '' });
  };
  const execFileSync = (_f: string, args: string[]) => (h.deleting ? deleteAnswer(args) : '');
  const mod = { ...real, exec, execFile, execFileSync, execSync: () => '' };
  return { ...mod, default: mod };
});
vi.mock('../../src/casaos/detector', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/casaos/detector')>()),
  getDeploymentMode: async () => 'docker',
}));
vi.mock('../../src/webui/server', () => ({ broadcastToClients: () => {} }));
vi.mock('../../src/docker/dockerClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/docker/dockerClient')>()),
  composeUp: async () => {},
  verifyComposeProjectRunning: async () => ({ allRunning: true, problems: [] }),
  listBotContainers: async () => [],
}));
vi.mock('../../src/templates/pcsProcessing', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/templates/pcsProcessing')>()),
  fleetAppContainerName: () => 'app-1',
}));
vi.mock('../../src/instance/dbLogin', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/instance/dbLogin')>()),
  ensureManagerDbRole: vi.fn(async () => ({ ok: true })),
  forgetManagerRole: vi.fn(),
}));
vi.mock('../../src/instance/fleetReplication', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/instance/fleetReplication')>()),
  narrowKeptPlainHba: vi.fn(async () => 'pg_hba was narrowed'),
}));
vi.mock('../../src/instance/fleetBackup', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/instance/fleetBackup')>();
  return { ...real, fenceStartWarning: vi.fn(async () => null) };
});

import * as fs from 'fs';
import * as path from 'path';
import * as containerManager from '../../src/docker/containerManager';
import * as dbLogin from '../../src/instance/dbLogin';
import * as fleetBackup from '../../src/instance/fleetBackup';
import { logCollectors } from '../../src/build/logCollector';

const fleetDb = { containerName: 'bot1-fleet-postgres', user: 'smdb', db: 'smdb', volume: 'bot1-fleet-postgres-data' };
const NO_ANSWER = "The database did not answer within 30 seconds of the start, so the manager could not check it for a write fence yet; the manager's own database role is created at its first login instead";
const ensure = () => (dbLogin as any).ensureManagerDbRole;

const record = (over: Record<string, unknown> = {}) => ({
  id: 'b1', sanitizedName: 'bot1', displayName: 'Bot 1', titleName: 'Bot 1', status: 'stopped',
  sourceType: 'docker-image', imageRef: 'example/bot:1', envVars: {}, containerIds: [], fleetDb,
  createdAt: '2026-10-24T00:00:00.000Z', updatedAt: '2026-10-24T00:00:00.000Z', ...over,
});
const writeRegistry = (b1: Record<string, unknown> | null = record()) =>
  fs.writeFileSync(path.join(h.dir, 'instances.json'), JSON.stringify({ instances: b1 ? { b1 } : {} }));
const readB1 = () => JSON.parse(fs.readFileSync(path.join(h.dir, 'instances.json'), 'utf-8')).instances.b1;

const arrangeStart = (over: Record<string, unknown> = {}) => {
  const appDir = path.join(h.dir, 'DATA', 'AppData', 'casaos', 'apps', 'bot1');
  fs.mkdirSync(appDir, { recursive: true });
  fs.writeFileSync(path.join(appDir, 'docker-compose.yml'), 'name: bot1\nservices:\n  fleet-postgres:\n    container_name: bot1-fleet-postgres\n    image: postgres:16\n');
  writeRegistry(record(over));
  const botDir = path.join(h.dir, 'bots', 'b1');
  fs.mkdirSync(botDir, { recursive: true });
  fs.writeFileSync(path.join(botDir, 'docker-compose.yml'), 'name: bot1\nservices:\n  app:\n    image: example/bot:1\n');
};

const captureWarn = () => {
  const warned: string[] = [];
  const spy = vi.spyOn(console, 'warn').mockImplementation((m: unknown) => { warned.push(String(m)); });
  return { warned, restore: () => spy.mockRestore() };
};

beforeEach(() => {
  h.shell.length = 0;
  h.execOpts.length = 0;
  h.notReady = false;
  h.notReadyLeft = 0;
  h.hang = false;
  h.ps = null;
  h.deleting = false;
  Object.assign((containerManager as any).START_DB_READY, { deadlineMs: 30_000, tryMs: 5_000, pauseMs: 1000 });
  ensure().mockReset();
  ensure().mockImplementation(async () => ({ ok: true }));
  (dbLogin as any).forgetManagerRole.mockClear();
  (fleetBackup as any).fenceStartWarning.mockClear();
});

afterAll(() => fs.rmSync(h.dir, { recursive: true, force: true }));

describe('updateInstanceMaintenance', () => {
  const rec = { state: 'maintenance', message: 'Back soon', orderedAt: '2026-10-02T10:00:00.000Z', settled: true } as any;

  it('saves the record on the bot and null removes it', () => {
    writeRegistry(record({ updatedAt: '2000-01-01T00:00:00.000Z' }));
    containerManager.updateInstanceMaintenance('b1', rec);
    expect(readB1().maintenance).toEqual(rec);
    expect(readB1().updatedAt).not.toBe('2000-01-01T00:00:00.000Z');
    containerManager.updateInstanceMaintenance('b1', null);
    expect('maintenance' in readB1()).toBe(false);
  });

  it('throws the exact text for a bot no longer in the registry', () => {
    writeRegistry(null);
    expect(() => containerManager.updateInstanceMaintenance('b1', rec)).toThrow(/^the bot is no longer in the registry$/);
  });

  it('a registry that cannot be read is named, not called a missing bot', () => {
    fs.writeFileSync(path.join(h.dir, 'instances.json'), '{"instances": {"b1": ');
    let err: Error | undefined;
    try { containerManager.updateInstanceMaintenance('b1', rec); } catch (e) { err = e as Error; }
    expect(err?.message).toMatch(/instances\.json/);
    expect(err?.message).not.toContain('no longer in the registry');
  });
});

describe('startFleetDbSidecar role warning', () => {
  it('logs the exact text when dbm_admin cannot be confirmed', async () => {
    arrangeStart();
    ensure().mockImplementationOnce(async () => ({ ok: false, error: 'role refused' }));
    const w = captureWarn();
    try {
      const r = await containerManager.startFleetDbSidecar('b1');
      expect(r.success).toBe(true);
      expect(w.warned).toContain("[ContainerManager] b1: the manager's database role dbm_admin could not be confirmed: role refused");
    } finally { w.restore(); }
  });
});

describe('databaseReady', () => {
  it('returns false without a try when the deadline is already reached', async () => {
    Object.assign((containerManager as any).START_DB_READY, { deadlineMs: 0 });
    expect(await (containerManager as any).databaseReady(fleetDb)).toBe(false);
    expect(h.execOpts.length).toBe(0);
  });

  it('the last try is cut at the time left, and the wait ends at the deadline itself', async () => {
    Object.assign((containerManager as any).START_DB_READY, { deadlineMs: 8000, tryMs: 5000, pauseMs: 1000 });
    vi.useFakeTimers();
    try {
      h.hang = true;
      let result: boolean | undefined;
      void (containerManager as any).databaseReady(fleetDb).then((r: boolean) => { result = r; });
      await vi.advanceTimersByTimeAsync(7999);
      expect(result).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1);
      expect(result).toBe(false);
      expect(h.execOpts.map(o => o.timeout)).toEqual([5000, 2000]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('gives up without a pause when exactly one pause is left', async () => {
    Object.assign((containerManager as any).START_DB_READY, { deadlineMs: 6000, tryMs: 5000, pauseMs: 1000 });
    vi.useFakeTimers();
    try {
      h.hang = true;
      let result: boolean | undefined;
      void (containerManager as any).databaseReady(fleetDb).then((r: boolean) => { result = r; });
      await vi.advanceTimersByTimeAsync(5000);
      expect(result).toBe(false);
      expect(h.execOpts).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('pauses between failed tries', async () => {
    Object.assign((containerManager as any).START_DB_READY, { deadlineMs: 60, pauseMs: 25 });
    h.notReady = true;
    expect(await (containerManager as any).databaseReady(fleetDb)).toBe(false);
    expect(h.execOpts.length).toBeGreaterThan(0);
    expect(h.execOpts.length).toBeLessThanOrEqual(4);
  });
});

describe('startBot after compose up', () => {
  it('a role check that throws is logged with its message', async () => {
    arrangeStart();
    ensure().mockImplementation(async () => { throw new Error('boom'); });
    const w = captureWarn();
    try {
      const r = await containerManager.startBot('b1');
      expect(r.success).toBe(true);
      expect(w.warned).toContain("[ContainerManager] b1: the manager's database role dbm_admin could not be confirmed after the start: boom");
    } finally { w.restore(); }
  });

  it('the no-answer text is logged with [Start] and joined to an earlier warning', async () => {
    arrangeStart({ fleetDb: { ...fleetDb, keptPlain: ['host all all 0.0.0.0/0 md5'] } });
    Object.assign((containerManager as any).START_DB_READY, { deadlineMs: 30, pauseMs: 1 });
    h.notReady = true;
    logCollectors.get('b1').clear();
    const r = await containerManager.startBot('b1');
    expect(r.success).toBe(true);
    expect(r.warning).toContain(`pg_hba was narrowed; ${NO_ANSWER}`);
    expect(logCollectors.get('b1').getLogs().map(l => l.message)).toContain(`[Start] ${NO_ANSWER}`);
  });

  it('a bot without a database gets no fence check', async () => {
    arrangeStart({ fleetDb: undefined });
    const r = await containerManager.startBot('b1');
    expect(r.success).toBe(true);
    expect((fleetBackup as any).fenceStartWarning).not.toHaveBeenCalled();
  });
});

describe('appContainerRunning', () => {
  it('a container id is true, none is false, no docker answer is null', async () => {
    writeRegistry();
    h.ps = 'abc123\n';
    expect(await containerManager.appContainerRunning('b1')).toBe(true);
    h.ps = '';
    expect(await containerManager.appContainerRunning('b1')).toBe(false);
    h.ps = new Error('Cannot connect to the Docker daemon');
    expect(await containerManager.appContainerRunning('b1')).toBeNull();
  });
});

describe('startBotInOp', () => {
  it('refuses with the exact text when the op is not held, and starts under the held op', async () => {
    arrangeStart();
    expect(await containerManager.startBotInOp('b1', 'maintenance')).toEqual({ success: false, error: "the start must run under the 'maintenance' operation, which is not held" });
    const r = await containerManager.withExternalBotOp('b1', 'maintenance', () => containerManager.startBotInOp('b1', 'maintenance'));
    expect(r.success).toBe(true);
  });
});

describe('deleteBot', () => {
  it('forgets the manager role of the database and the copy', async () => {
    h.deleting = true;
    fs.mkdirSync(path.join(h.dir, 'bots', 'b1', 'env'), { recursive: true });
    writeRegistry(record({ fleetDbReplica: { containerName: 'bot1-fleet-postgres-replica' } }));
    await expect(containerManager.deleteBot('b1', true, true, true, true)).resolves.toBe(true);
    const forgotten = (dbLogin as any).forgetManagerRole.mock.calls.map((c: unknown[]) => c[0]);
    expect(forgotten).toEqual(['bot1-fleet-postgres', 'bot1-fleet-postgres-replica']);
  });
});
