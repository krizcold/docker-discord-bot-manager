import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'fu-6-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  const deferred = () => {
    let resolve!: () => void;
    const promise = new Promise<void>(r => { resolve = r; });
    return { promise, resolve };
  };
  return {
    dir, deferred,
    // What each `docker ps -q` answers in turn (the last one sticks); null when docker does not answer.
    ps: [''] as Array<string | null>,
    mode: 'docker' as 'docker' | 'casaos',
    upFails: false,
    cfgCorrupt: false,
    refuseStatus: '',
    refusePending: false,
    events: [] as string[],
    installs: [] as string[],
    settles: [] as Array<string | null>,
    hookGate: null as null | Promise<void>,
    downGate: null as null | Promise<void>,
  };
});

const nextPs = (): string | null => (h.ps.length > 1 ? h.ps.shift()! : h.ps[0]);

vi.mock('child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('child_process')>();
  const fail = (stderr: string): Error => Object.assign(new Error(stderr), { stderr });
  const answer = (args: string[]): string => {
    const line = args.join(' ');
    if (line.startsWith('image inspect')) throw fail('Error: No such image: x');
    if (line.startsWith('volume')) throw fail('Error: No such volume: x');
    return '';
  };
  const execFileSync = (_f: string, args: string[]) => answer(args);
  const execFile = (_f: string, args: string[], opts: any, cb?: any) => {
    const done = typeof opts === 'function' ? opts : cb;
    try { done(null, { stdout: answer(args), stderr: '' }); } catch (e) { done(e); }
  };
  const execSync = () => '';
  const exec = (cmd: string, opts: any, cb?: any) => {
    const done = typeof opts === 'function' ? opts : cb;
    if (/ up -d/.test(cmd)) h.events.push(`exec-up ${cmd.split(' up -d')[1].trim()}`);
    if (cmd.startsWith('docker ps')) {
      const ps = nextPs();
      if (ps === null) done(new Error('Cannot connect to the Docker daemon'));
      else done(null, { stdout: ps, stderr: '' });
    } else if (cmd.startsWith('docker inspect')) done(new Error('Error: No such object'));
    else if (cmd.startsWith('docker rm')) done(new Error('Error: No such container'));
    else done(null, { stdout: '', stderr: '' });
  };
  const mod = { ...real, exec, execFile, execFileSync, execSync };
  return { ...mod, default: mod };
});
// Registry saves are refused when the record being written has the status in
// h.refuseStatus, or (h.refusePending) carries pendingApply.
vi.mock('fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('fs')>();
  const enospc = (p: unknown): Error => Object.assign(new Error(`ENOSPC: no space left on device, write '${p}'`), { code: 'ENOSPC' });
  const mod = {
    ...real,
    renameSync: (a: any, b: any) => {
      if (String(b).endsWith('instances.json')) {
        const next = JSON.parse(real.readFileSync(a, 'utf-8')).instances?.b1;
        if (h.refuseStatus && next?.status === h.refuseStatus) throw enospc(b);
        if (h.refusePending && next?.pendingApply === true) throw enospc(b);
      }
      return real.renameSync(a, b);
    },
  };
  return { ...mod, default: mod };
});
vi.mock('../../src/casaos/detector', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/casaos/detector')>()),
  getDeploymentMode: async () => h.mode,
}));
vi.mock('../../src/casaos/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/casaos/api')>()),
  deployApp: async () => { h.events.push('deployApp'); return h.upFails ? { success: false, error: 'compose up timed out' } : { success: true }; },
  composeDown: async () => { h.events.push('casaosDown'); return { success: true }; },
}));
vi.mock('../../src/docker/dockerClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/docker/dockerClient')>()),
  pullImage: async () => { h.events.push('pull'); },
  composeUp: async () => { h.events.push('composeUp'); if (h.upFails) throw new Error('compose up timed out'); },
  composeDown: async () => { h.events.push('composeDown'); if (h.downGate) await h.downGate; },
  verifyComposeProjectRunning: async () => ({ allRunning: true, problems: [] }),
  listBotContainers: async () => [],
  listContainersByBotId: async () => [],
  checkDockerConnection: async () => true,
  imageState: async () => 'exists',
}));
vi.mock('../../src/templates/pcsProcessing', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/templates/pcsProcessing')>()),
  writeComposeEnvFile: async () => '',
  fixPostDeployOwnership: async () => {},
  fixDockerBotOwnership: () => {},
  executeInstallCommand: async (phase: string) => { h.installs.push(phase); return true; },
}));
vi.mock('../../src/config/configFileManager', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/config/configFileManager')>()),
  getConfigFilesWithStatus: () => ({ files: [], undecryptable: [], corrupt: h.cfgCorrupt }),
  getBuiltMounts: () => [],
}));
vi.mock('../../src/instance/appLifecycle', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/instance/appLifecycle')>()),
  waitForAppHook: async () => { if (h.hookGate) await h.hookGate; return { success: true }; },
  settleCopyBlockRetract: async (botId: string) => {
    const cm = await import('../../src/docker/containerManager');
    h.settles.push(cm.isBotBusy(botId));
    return { pending: false };
  },
}));
vi.mock('../../src/webui/server', () => ({ broadcastToClients: () => {} }));

import * as fs from 'fs';
import * as path from 'path';
import * as containerManager from '../../src/docker/containerManager';
import '../../src/instance/appLifecycle';

const botDir = path.join(h.dir, 'bots', 'b1');
const composePath = path.join(botDir, 'docker-compose.yml');
const stored = (): any => JSON.parse(fs.readFileSync(path.join(h.dir, 'instances.json'), 'utf-8')).instances.b1;
const RETIRING = '2026-10-20T00:00:00.000Z';
const fleetDb = { containerName: 'bot1-postgres', user: 'app', db: 'app', volume: 'bot1-pgdata' };

const seed = (status: string, extra: Record<string, unknown> = {}): void => {
  fs.writeFileSync(path.join(h.dir, 'instances.json'), JSON.stringify({
    instances: {
      b1: {
        id: 'b1', sanitizedName: 'bot1', displayName: 'Bot 1', titleName: 'Bot 1', status,
        sourceType: 'docker-image', imageRef: 'img:1', envVars: {},
        createdAt: '2026-10-22T00:00:00.000Z', updatedAt: '2026-10-22T00:00:00.000Z', ...extra,
      },
    },
  }));
};

beforeEach(() => {
  h.ps = [''];
  h.mode = 'docker';
  h.upFails = false;
  h.cfgCorrupt = false;
  h.refuseStatus = '';
  h.refusePending = false;
  h.events.length = 0;
  h.installs.length = 0;
  h.settles.length = 0;
  h.hookGate = null;
  h.downGate = null;
  fs.rmSync(path.join(h.dir, 'bots'), { recursive: true, force: true });
  fs.mkdirSync(path.join(botDir, 'env'), { recursive: true });
  fs.writeFileSync(composePath, 'services:\n  app:\n    image: img:1\n');
  seed('stopped');
});

afterAll(() => {
  fs.rmSync(h.dir, { recursive: true, force: true });
});

describe('B20-4b no compose up runs over a half-retired fleet database', () => {
  it('the start preflight the routes answer refuses on the retiring mark', () => {
    seed('stopped', { fleetDb: { ...fleetDb, retiringAt: RETIRING } });
    expect(containerManager.startPreflightRefusal('b1')?.error).toBe(containerManager.unfinishedRetireRefusal(RETIRING));
  });

  it('a restart refuses before it stops the running bot', async () => {
    seed('running', { fleetDb: { ...fleetDb, retiringAt: RETIRING } });
    h.ps = ['abc123\n'];
    const res = await containerManager.restartBot('b1');
    expect(res.success).toBe(false);
    expect(res.error).toBe(containerManager.unfinishedRetireRefusal(RETIRING));
    expect(h.events).toEqual([]);
    expect(stored().status).toBe('running');
  });

  it('an update of a running bot refuses before it stops or rebuilds anything', async () => {
    seed('running', { fleetDb: { ...fleetDb, retiringAt: RETIRING } });
    h.ps = ['abc123\n'];
    const res = await containerManager.pullAndRebuild('b1');
    expect(res.success).toBe(false);
    expect(res.error).toContain(containerManager.unfinishedRetireRefusal(RETIRING));
    expect(h.events).toEqual([]);
    expect(stored().status).toBe('running');
  });

  it('the standby service apply refuses and writes nothing into the compose', async () => {
    seed('stopped', {
      fleetDb: { ...fleetDb, retiringAt: RETIRING },
      fleetDbReplica: { containerName: 'bot1-postgres-replica', volume: 'bot1-replica-data', hostPort: 5440, user: 'app', db: 'app' },
    });
    const before = fs.readFileSync(composePath, 'utf-8');
    const res = await containerManager.applyFleetDbReplicaService('b1');
    expect(res.success).toBe(false);
    expect(res.error).toBe(containerManager.unfinishedRetireRefusal(RETIRING));
    expect(h.events).toEqual([]);
    expect(fs.readFileSync(composePath, 'utf-8')).toBe(before);
  });
});

describe('B08-5w the start answers name what could not be recorded', () => {
  it('a refused pending-apply record says the unapplied changes were not recorded, not that the build is applied', async () => {
    h.cfgCorrupt = true;
    h.refusePending = true;
    const res = await containerManager.startBot('b1');
    expect(res.success).toBe(true);
    expect(res.notApplied?.length).toBeGreaterThan(0);
    expect(res.warning).not.toMatch(/The deployed build is applied/);
    expect(res.warning).toMatch(/could not be recorded as pending.*ENOSPC/);
    expect(stored().pendingApply).toBeUndefined();
  });

  it('the CasaOS image lane writes the env into the compose before deploying', async () => {
    h.mode = 'casaos';
    const res = await containerManager.startBot('b1');
    expect(res.success).toBe(true);
    expect(h.events).toContain('deployApp');
    expect(fs.readFileSync(composePath, 'utf-8')).toMatch(/BOT_ID: b1/);
  }, 20_000);
});

describe('B07-2s a failed start keeps the status the reconcile recorded', () => {
  it('running corrected to stopped stays stopped when docker then stops answering', async () => {
    seed('running');
    h.ps = ['', null];
    h.upFails = true;
    const res = await containerManager.startBot('b1');
    expect(res.success).toBe(false);
    expect(stored().status).toBe('stopped');
  });
});

describe('B04-3c the post-install command runs once per install', () => {
  it('a refused running stamp does not run the post-install command again at the next start', async () => {
    h.mode = 'casaos';
    seed('stopped', { sourceType: 'git', imageRef: undefined, sourceId: 's1' });
    h.refuseStatus = 'running';
    const first = await containerManager.startBot('b1');
    expect(first.success).toBe(true);
    expect(first.warning).toMatch(/status could not be recorded/);
    expect(h.installs).toEqual(['post']);
    const second = await containerManager.startBot('b1');
    expect(second.success).toBe(true);
    expect(h.installs).toEqual(['post']);
  }, 30_000);
});

describe('B19-2s the copy-block retraction waits for the op lock', () => {
  it('a retraction whose hooks answer while another lane holds the lock is sent once the lock is free', async () => {
    seed('stopped', { copyBlockRetract: { host: 'primary.invalid', port: 15432, since: '2026-10-24T00:00:00.000Z' } });
    const hook = h.deferred();
    const down = h.deferred();
    h.hookGate = hook.promise;
    h.downGate = down.promise;
    const res = await containerManager.startBot('b1');
    expect(res.success).toBe(true);
    const stop = containerManager.stopBot('b1');
    await new Promise(r => setTimeout(r, 20));
    expect(containerManager.isBotBusy('b1')).toBe('stop');
    hook.resolve();
    await new Promise(r => setTimeout(r, 100));
    expect(h.settles).toEqual([]);
    down.resolve();
    await stop;
    for (let i = 0; i < 300 && h.settles.length === 0; i++) await new Promise(r => setTimeout(r, 10));
    expect(h.settles).toEqual([null]);
  }, 20_000);
});
