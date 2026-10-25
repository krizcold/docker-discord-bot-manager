import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'b16-3d-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return {
    dir,
    volumes: new Map<string, 'exists' | 'unknown'>(),
    removedVolumes: [] as string[],
    probes: 0,
    held: null as null | (() => void),
  };
});

const volState = (name: string): 'exists' | 'absent' | 'unknown' => h.volumes.get(name) ?? 'absent';

// A fake docker: volumes answer from h.volumes; the rescue's volume probe waits until the row lets it answer 'empty'.
vi.mock('child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('child_process')>();
  const execFile = (_cmd: string, args: string[], opts: any, cb?: any) => {
    const done = typeof opts === 'function' ? opts : cb;
    if (args[0] === 'volume' && args[1] === 'inspect') {
      const state = volState(args[args.length - 1]);
      if (state === 'exists') return done(null, '2026-10-01T00:00:00Z\n', '');
      return done(new Error('fail'), '', state === 'absent' ? 'Error: No such volume' : 'Cannot connect to the Docker daemon');
    }
    if (args[0] === 'run' && args.some((a) => a.includes('echo partial'))) {
      h.probes++;
      h.held = () => done(null, 'empty\n', '');
      return {};
    }
    if (args[0] === 'inspect') return done(new Error('fail'), '', 'Error: No such object');
    if (args[0] === 'ps') return done(null, '', '');
    done(null, '', '');
    return {};
  };
  const exec = (cmd: string, opts: any, cb?: any) => {
    const done = typeof opts === 'function' ? opts : cb;
    if (cmd.startsWith('docker inspect')) done(new Error('Error: No such object'));
    else if (cmd.startsWith('docker rm')) done(new Error('Error: No such container'));
    else done(null, { stdout: '', stderr: '' });
  };
  const mod = { ...real, execFile, exec };
  return { ...mod, default: mod };
});
vi.mock('../../src/docker/dockerClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/docker/dockerClient')>()),
  composeDown: async () => {},
  imageState: async () => 'absent',
  removeImage: async () => true,
  listProjectVolumes: () => [],
  removeVolume: (name: string) => { h.removedVolumes.push(name); h.volumes.delete(name); return true; },
  checkDockerConnection: async () => true,
  listContainersByBotId: async () => [],
  volumeState: (name: string) => volState(name),
}));
vi.mock('../../src/casaos/detector', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/casaos/detector')>()),
  getDeploymentMode: async () => 'docker',
}));
vi.mock('../../src/webui/server', () => ({ broadcastToClients: () => {} }));

import * as fs from 'fs';
import * as path from 'path';
import * as containerManager from '../../src/docker/containerManager';
import * as recoveryRescue from '../../src/instance/recoveryRescue';
import { createBotRoutes } from '../../src/webui/routes/bots';

const DB = 'bot1-fleet-postgres-data';
const fleetDb = { containerName: 'bot1-fleet-postgres', user: 'smdb', db: 'smdb', volume: DB };
const channel = { mode: 'receiver', containerName: 'bot1-recovery-channel', token: 'fake', createdAt: 1 };
const rescueAt = (phase: string, parked = false) => ({ phase, startedAt: 1, updatedAt: 1, ...(parked ? { parked: true, lastError: 'parked' } : {}) });

const registryPath = path.join(h.dir, 'instances.json');
const writeRegistry = (over: Record<string, unknown> = {}): void => {
  fs.writeFileSync(registryPath, JSON.stringify({
    instances: {
      b1: {
        id: 'b1', sanitizedName: 'bot1', displayName: 'Bot 1', titleName: 'Bot 1', status: 'stopped',
        sourceType: 'docker-image', envVars: {},
        createdAt: '2026-10-24T00:00:00.000Z', updatedAt: '2026-10-24T00:00:00.000Z',
        fleetDb,
        ...over,
      },
    },
  }));
};
const registered = (): boolean => 'b1' in JSON.parse(fs.readFileSync(registryPath, 'utf-8')).instances;
const botDir = path.join(h.dir, 'bots', 'b1');
const keptCompose = path.join(botDir, 'docker-compose.lane-held.json');
const waitFor = async (cond: () => boolean): Promise<void> => {
  for (let i = 0; i < 300 && !cond(); i++) await new Promise((r) => setTimeout(r, 10));
};
const untouched = (): void => {
  expect(registered()).toBe(true);
  expect(fs.existsSync(botDir)).toBe(true);
  expect(fs.readFileSync(keptCompose, 'utf-8')).toBe('{"kept":true}');
  expect(h.removedVolumes).toEqual([]);
};

const router = createBotRoutes({ clients: new Set() } as any);
const handler = (method: string, routePath: string) => {
  const layer = (router as any).stack.find((l: any) => l.route?.path === routePath && l.route.methods[method]);
  return layer.route.stack[layer.route.stack.length - 1].handle;
};
const call = async (method: string, routePath: string, req: any): Promise<{ status: number; body: any }> => {
  const out = { status: 200, body: undefined as any };
  const res = { status(code: number) { out.status = code; return res; }, json(body: any) { out.body = body; return res; } };
  await handler(method, routePath)({ query: {}, body: {}, ...req }, res);
  return out;
};

beforeEach(async () => {
  await waitFor(() => containerManager.isBotBusy('b1') === null);
  h.volumes = new Map();
  h.removedVolumes = [];
  h.probes = 0;
  h.held = null;
  fs.rmSync(path.join(h.dir, 'bots'), { recursive: true, force: true });
  fs.mkdirSync(path.join(botDir, 'env'), { recursive: true });
  fs.writeFileSync(keptCompose, '{"kept":true}');
});

afterAll(() => {
  fs.rmSync(h.dir, { recursive: true, force: true });
});

describe('Remove while a rescue is on record', () => {
  it('refuses a keep-data Remove during a running rescue and leaves the bot folder and the kept compose', async () => {
    writeRegistry({ recoveryRescue: rescueAt('bulk') });
    h.volumes.set(DB, 'exists');
    await expect(containerManager.deleteBot('b1', true, true)).rejects.toThrow(/rescue on this instance is running \(phase bulk\).*Cancel the rescue on its rescue block first\. Nothing was removed/);
    untouched();
    expect(h.volumes.get(DB)).toBe('exists');
  });

  it('refuses a data-deleting Remove during a running rescue even when the volume is gone', async () => {
    writeRegistry({ recoveryRescue: rescueAt('streaming') });
    await expect(containerManager.deleteBot('b1', false, false)).rejects.toThrow(/rescue on this instance is running \(phase streaming\)/);
    untouched();
  });

  it('refuses a Remove during a parked rescue', async () => {
    writeRegistry({ recoveryRescue: rescueAt('preflight', true) });
    await expect(containerManager.deleteBot('b1', true, true)).rejects.toThrow(/rescue on this instance is parked at phase preflight.*Cancel the rescue/);
    untouched();
  });

  it('names Continue, not Cancel, for a rescue past promotion', async () => {
    writeRegistry({ recoveryRescue: rescueAt('teardown', true) });
    const err = await containerManager.deleteBot('b1', true, true).then(() => null, (e: Error) => e.message);
    expect(err).toMatch(/past promotion \(phase teardown\).*Continue on the rescue block\. Nothing was removed/);
    expect(err).not.toMatch(/Cancel/);
    untouched();
  });

  it.each(['teardown', 'flip'])('says to wait, naming neither Continue nor Cancel, while a running rescue drives the swap (%s)', async (phase) => {
    writeRegistry({ recoveryRescue: rescueAt(phase) });
    const err = await containerManager.deleteBot('b1', true, true).then(() => null, (e: Error) => e.message);
    expect(err).toMatch(new RegExp(`is finishing the swap \\(phase ${phase}\\); wait for it to end, then try Remove again\\. Nothing was removed`));
    expect(err).not.toMatch(/Continue|Cancel/);
    untouched();
  });

  it('the route answers 409 with the refusal', async () => {
    writeRegistry({ recoveryRescue: rescueAt('consistent') });
    const res = await call('delete', '/:id', { params: { id: 'b1' }, query: { keepData: 'true', keepEnv: 'true' } });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/rescue on this instance is running \(phase consistent\)/);
    untouched();
  });

  it('refuses while the runner of a cancelled rescue is still in its last step, and goes on once it ends', async () => {
    writeRegistry({ recoveryRescue: rescueAt('preflight'), recoveryChannel: channel });
    recoveryRescue.resumeRecoveryRescues();
    await waitFor(() => h.held !== null);
    expect(h.probes).toBe(1);
    writeRegistry({ recoveryChannel: channel });
    await expect(containerManager.deleteBot('b1', true, true)).rejects.toThrow(/still stopping its last step; try again in a moment\. Nothing was removed/);
    untouched();
    h.held!();
    await waitFor(() => !recoveryRescue.rescueRunnerLive('b1'));
    expect(recoveryRescue.rescueRunnerLive('b1')).toBe(false);
    await expect(containerManager.deleteBot('b1', true, true)).resolves.toBe(true);
    expect(registered()).toBe(false);
  });
});

describe('Remove after a rescue', () => {
  it('goes on once the rescue ended', async () => {
    writeRegistry({ recoveryLastSwap: { startedAt: 1, completedAt: 2 } });
    await expect(containerManager.deleteBot('b1', true, true)).resolves.toBe(true);
    expect(registered()).toBe(false);
  });

  it('refuses a keep-data Remove while a cancelled rescue left a partial copy, naming the exits', async () => {
    writeRegistry({ recoveryRescueLeft: { at: Date.parse('2026-10-20T10:00:00Z'), state: 'partial' } });
    h.volumes.set(DB, 'exists');
    await expect(containerManager.deleteBot('b1', true, true)).rejects.toThrow(/cancelled on 2026-10-20 left a partial copy of the sender's database on the database volume bot1-fleet-postgres-data\..*Start a rescue again to finish the copy, or decommission this database.*Nothing was removed/);
    untouched();
    expect(JSON.parse(fs.readFileSync(registryPath, 'utf-8')).instances.b1.recoveryRescueLeft.state).toBe('partial');
  });

  it('refuses a keep-data Remove while a cancelled rescue left a standby', async () => {
    writeRegistry({ recoveryRescueLeft: { at: Date.parse('2026-10-21T10:00:00Z'), state: 'standby' } });
    await expect(containerManager.deleteBot('b1', true, true)).rejects.toThrow(/left this instance's database as a standby of the sender/);
    untouched();
  });

  it('lets a data-deleting Remove go on over the mark once the volume is gone', async () => {
    writeRegistry({ recoveryRescueLeft: { at: 1, state: 'partial' } });
    await expect(containerManager.deleteBot('b1', false, false)).resolves.toBe(true);
    expect(registered()).toBe(false);
  });

  it('a data-deleting Remove over the mark still refuses while the volume exists, as before', async () => {
    writeRegistry({ recoveryRescueLeft: { at: 1, state: 'partial' } });
    h.volumes.set(DB, 'exists');
    await expect(containerManager.deleteBot('b1', false, false)).rejects.toThrow(/Decommission it/);
    untouched();
  });
});
