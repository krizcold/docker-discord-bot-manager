import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm10-l5-c-cm-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return { dir, ps: { fail: false, out: 'abc123\n' }, inspect: '', execs: [] as { cmd: string; opts: any }[] };
});

vi.mock('child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('child_process')>();
  const { EventEmitter } = await import('events');
  const execFile = (_cmd: string, args: string[], opts: any, cb?: any) => {
    const done = typeof opts === 'function' ? opts : cb;
    if (args[0] === 'volume' && args[1] === 'inspect') { setTimeout(() => done(new Error('fail'), '', 'Error: No such volume'), 1); return new EventEmitter(); }
    setTimeout(() => done(null, '', ''), 1);
    return new EventEmitter();
  };
  const exec = (cmd: string, opts: any, cb?: any) => {
    const done = typeof opts === 'function' ? opts : cb;
    h.execs.push({ cmd, opts: typeof opts === 'function' ? undefined : opts });
    if (cmd.startsWith('docker ps')) {
      if (h.ps.fail) done(new Error('Cannot connect to the Docker daemon'));
      else done(null, { stdout: h.ps.out, stderr: '' });
    } else if (cmd.startsWith('docker inspect')) done(null, { stdout: h.inspect, stderr: '' });
    else done(null, { stdout: '', stderr: '' });
  };
  return { ...real, execFile, exec, default: { ...real, execFile, exec } };
});
vi.mock('../../src/casaos/detector', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/casaos/detector')>()),
  getDeploymentMode: async () => 'docker',
}));
vi.mock('../../src/webui/server', () => ({ broadcastToClients: () => {} }));

import * as fs from 'fs';
import * as path from 'path';
import * as containerManager from '../../src/docker/containerManager';
import * as envManager from '../../src/env/manager';
import { MIGRATE_GATE } from '../../src/docker/containerManager';

const SMDB = 'https://example.invalid/fake/super-modular-discord-bot';
const REGISTRY = path.join(h.dir, 'instances.json');
const SIDE = 'b-fleet-postgres';
const writeRegistry = (over: Record<string, unknown> = {}) => fs.writeFileSync(REGISTRY, JSON.stringify({
  instances: {
    b: {
      id: 'b', sanitizedName: 'b', displayName: 'B', titleName: 'B', status: 'running', sourceType: 'git', sourceUrl: SMDB,
      envVars: { DATA_BACKEND: 'postgres' }, createdAt: '2026-10-24T00:00:00.000Z', updatedAt: '2026-10-24T00:00:00.000Z', ...over,
    },
  },
}));
const bot = () => containerManager.getBot('b')!;
const withUrl = (url: string, over: Record<string, unknown> = {}) => {
  writeRegistry(over);
  envManager.setEnvVars('b', { DATA_BACKEND: 'postgres', DATA_BACKEND_URL: url });
  return containerManager.ensureFleetDataBackend(bot());
};
const fleetDb = (publicHost?: string) => ({
  containerName: SIDE, user: 'smdb', db: 'smdb', volume: 'b-fleet-postgres-data',
  ...(publicHost ? { replication: { publicHost, hostPort: 15433 } } : {}),
});

beforeEach(() => {
  h.ps.fail = false;
  h.ps.out = 'abc123\n';
  h.inspect = '';
  h.execs.length = 0;
  fs.rmSync(path.join(h.dir, 'bots'), { recursive: true, force: true });
  fs.mkdirSync(path.join(h.dir, 'bots', 'b', 'env'), { recursive: true });
  writeRegistry();
});
afterAll(() => { fs.rmSync(h.dir, { recursive: true, force: true }); });

describe('the addresses of the running app container', () => {
  it('a docker that does not answer says so and asks nothing more', async () => {
    h.ps.fail = true;
    h.inspect = '172.18.0.5 \n';
    expect(await containerManager.appContainerAddresses('b')).toEqual({ ok: false, error: 'docker did not answer' });
    expect(h.execs.some(e => e.cmd.startsWith('docker inspect'))).toBe(false);
  });

  it('a stopped container says it is not running', async () => {
    h.ps.out = '\n';
    expect(await containerManager.appContainerAddresses('b')).toEqual({ ok: false, error: 'the bot container is not running' });
  });

  it('reads each address once, without the blanks a missing IPv6 leaves, under a 30 second limit', async () => {
    h.inspect = '172.18.0.5  10.0.1.7 fd00::7 172.18.0.5  \n';
    expect(await containerManager.appContainerAddresses('b')).toEqual({ ok: true, addresses: ['172.18.0.5', '10.0.1.7', 'fd00::7'] });
    const inspect = h.execs.find(e => e.cmd.startsWith('docker inspect'))!;
    expect(inspect.cmd.endsWith(' abc123')).toBe(true);
    expect(inspect.opts).toEqual({ timeout: 30_000 });
  });
});

const RECORD = { to: 'postgres', from: 'file', destination: null, companion: true, jobId: 'mgr-c1', jobIds: ['mgr-c1'], posted: true, started: 1, kept: 0, phase: 'following', loginOpened: false, openedAt: 'x', text: 't' };

describe('a start or build of a bot with an open migration', () => {
  it('a plain start is refused with MG-START', async () => {
    writeRegistry({ status: 'stopped', migrate: { ...RECORD } });
    expect(await containerManager.startBot('b')).toEqual({ success: false, error: MIGRATE_GATE.start('Postgres') });
  });

  it('a start under another held op is refused with MG-START', async () => {
    writeRegistry({ status: 'stopped', migrate: { ...RECORD } });
    const r = await containerManager.withExternalBotOp('b', 'stop', () => containerManager.startBotInOp('b', 'stop'));
    expect(r).toEqual({ success: false, error: MIGRATE_GATE.start('Postgres') });
  });

  it('the migrate lane start with no compose logs MG-NEEDS-BUILD and builds nothing', async () => {
    writeRegistry({ status: 'stopped', migrate: { ...RECORD } });
    const r = await containerManager.withExternalBotOp('b', 'migrate', () => containerManager.startBotInOp('b', 'migrate'));
    expect(r).toEqual({ success: false, error: MIGRATE_GATE.needsBuild });
    const lines = containerManager.getBotLogCollector('b').getLogs().map(e => `${e.type} ${e.message}`);
    expect(lines).toContain(`error [Start] ${MIGRATE_GATE.needsBuild}`);
  });

  it('a Build after an unfinished Delete names Build in its refusal', () => {
    writeRegistry({ lane: { op: 'delete', wasRunning: false, keepData: true, startedAt: '2026-11-01T00:00:00.000Z' } });
    expect(containerManager.buildPreflightRefusal('b')).toEqual({ success: false, error: 'A Delete of this instance (keeping its data) did not finish, so its containers, image or compose may already be gone; Build is refused until Delete is run again' });
  });
});

describe('which stored Database URL names the managed sidecar', () => {
  it('a URL whose scheme is not postgres has no address and is no sidecar', () => {
    expect(withUrl('http://smdb:pw@b-fleet-postgres:5432/smdb')).toBeNull();
  });

  it('a URL naming another host is the external lane', () => {
    expect(withUrl('postgresql://smdb:pw@db.example.invalid:5432/smdb')).toBeNull();
  });

  it('a URL naming the sidecar container is managed', () => {
    expect(withUrl('postgresql://smdb:pw@b-fleet-postgres:5432/smdb')).toMatchObject({ containerName: SIDE, password: 'pw' });
  });

  it('a URL naming the replication public host, stored in brackets and capitals, is managed', () => {
    expect(withUrl('postgresql://smdb:pw@[2001:db8::5]:15433/smdb', { fleetDb: fleetDb('[2001:DB8::5]') }))
      .toMatchObject({ containerName: SIDE, password: 'pw' });
  });

  it('a URL naming a host other than the replication public host is the external lane', () => {
    expect(withUrl('postgresql://smdb:pw@db.example.invalid:5432/smdb', { fleetDb: fleetDb('copy.invalid') })).toBeNull();
  });
});
