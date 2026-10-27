import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'fu-f-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return {
    dir,
    probe: 'f|||\n',
    stripFails: false,
    calls: [] as string[][],
    enabled: 0,
    hooks: false,
    facts: {} as Record<string, unknown>,
  };
});

// A fake docker: inspect says running, the status probe answers h.probe, and the
// fence strip (a root sh -c naming the fence marker) fails when h.stripFails.
vi.mock('child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('child_process')>();
  const { EventEmitter } = await import('events');
  const { PassThrough } = await import('stream');
  const execFile = (_cmd: string, args: string[], opts: any, cb?: any) => {
    const done = typeof opts === 'function' ? opts : cb;
    h.calls.push(args);
    const line = args.join(' ');
    if (args[0] === 'inspect') setImmediate(() => done(null, 'true\n', ''));
    else if (args[0] === 'exec' && line.includes('smdb-write-fence')) {
      setImmediate(() => h.stripFails ? done(new Error('exit 1'), '', 'sed: cannot rename pg_hba.conf: Read-only file system\n') : done(null, '', ''));
    } else if (args[0] === 'exec' && line.includes('pg_is_in_recovery(),')) setImmediate(() => done(null, h.probe, ''));
    else setImmediate(() => done(null, '', ''));
    const child: any = new EventEmitter();
    child.stdin = new PassThrough();
    return child;
  };
  const spawn = () => {
    const child: any = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.kill = () => {};
    setTimeout(() => { child.stdout.end(''); child.stderr.end(''); setTimeout(() => child.emit('close', 0), 1); }, 1);
    return child;
  };
  return { ...real, execFile, spawn, default: { ...real, execFile, spawn } };
});
vi.mock('../../src/instance/fleetReplication', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/instance/fleetReplication')>()),
  enableFleetReplication: async () => { h.enabled++; return { success: true }; },
}));
vi.mock('../../src/instance/appHookClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/instance/appHookClient')>()),
  hasAppHooks: () => h.hooks,
}));
vi.mock('../../src/instance/appHookClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/instance/appHookClient')>()),
  capabilityRefusal: () => null,
  getAppFacts: async () => ({ success: true, facts: h.facts }),
}));
vi.mock('../../src/casaos/detector', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/casaos/detector')>()),
  getDeploymentMode: async () => 'docker',
}));
vi.mock('../../src/webui/server', () => ({ broadcastToClients: () => {} }));

import * as fs from 'fs';
import * as path from 'path';
import * as containerManager from '../../src/docker/containerManager';
import * as envManager from '../../src/env/manager';
import * as fleetReplica from '../../src/instance/fleetReplica';

const dbUrl = 'postgresql://smdb:Db-Secret-0123456789@bot1-fleet-postgres:5432/smdb';
const REPLICA = {
  containerName: 'bot1-fleet-postgres-replica', volume: 'bot1-fleet-postgres-replica-data', slot: 'fleet_standby_b1',
  primaryHost: 'primary.invalid', primaryPort: 5433, publicHost: 'standby.invalid', hostPort: 5440, certHost: 'standby.invalid',
  user: 'smdb', db: 'smdb',
};

const writeRegistry = (extra: Record<string, unknown> = {}): void => {
  fs.writeFileSync(path.join(h.dir, 'instances.json'), JSON.stringify({
    instances: {
      b1: {
        id: 'b1', sanitizedName: 'bot1', displayName: 'Bot 1', titleName: 'Bot 1', status: 'running',
        sourceType: 'git', sourceUrl: 'https://example.invalid/fake/super-modular-discord-bot',
        envVars: { DATA_BACKEND: 'postgres' },
        createdAt: '2026-10-24T00:00:00.000Z', updatedAt: '2026-10-24T00:00:00.000Z',
        ...extra,
      },
    },
  }));
};
const bot = () => containerManager.getBot('b1')!;
const stripIndex = () => h.calls.findIndex(a => a.join(' ').includes('smdb-write-fence'));

beforeEach(() => {
  h.probe = 'f|||\n';
  h.stripFails = false;
  h.calls.length = 0;
  h.enabled = 0;
  h.hooks = false;
  h.facts = {};
  fs.rmSync(path.join(h.dir, 'bots'), { recursive: true, force: true });
  fs.mkdirSync(path.join(h.dir, 'bots', 'b1', 'env'), { recursive: true });
  writeRegistry({ fleetDbReplica: { ...REPLICA } });
  envManager.setEnvVars('b1', { DATA_BACKEND_URL: dbUrl });
});

afterAll(() => { fs.rmSync(h.dir, { recursive: true, force: true }); });

describe('B14-2La: the adopt strips the write fence lines from pg_hba.conf', () => {
  it('strips them as root before the enable, and reloads after', async () => {
    const res = await fleetReplica.adoptPromotedReplica(bot());
    expect(res.success).toBe(true);
    const i = stripIndex();
    expect(i).toBeGreaterThanOrEqual(0);
    const strip = h.calls[i];
    expect(strip.slice(0, 4)).toEqual(['exec', '-u', 'root', REPLICA.containerName]);
    expect(strip.join(' ')).toContain("sed -i '/# smdb-write-fence$/d'");
    expect(strip.join(' ')).toContain('chown postgres:postgres');
    expect(strip.join(' ')).toContain('chmod 600');
    const reload = h.calls.findIndex((a, k) => k > i && a.join(' ').includes('pg_reload_conf'));
    expect(reload).toBeGreaterThan(i);
    expect(h.enabled).toBe(1);
  });

  it('refuses the adopt with the fence named when the strip fails, and changes nothing else', async () => {
    h.stripFails = true;
    const res = await fleetReplica.adoptPromotedReplica(bot());
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/write fence/);
    expect(res.error).toMatch(/Read-only file system/);
    expect(res.error).toMatch(/nothing was changed/);
    expect(h.enabled).toBe(0);
    expect(bot().fleetDb).toBeUndefined();
    expect(bot().fleetDbReplica?.containerName).toBe(REPLICA.containerName);
    expect(envManager.getEnvVars('b1').DATA_BACKEND_URL).toBe(dbUrl);
    expect(h.calls.some(a => a.join(' ').includes('ALTER SYSTEM RESET'))).toBe(false);
  });
});

describe('FU-7c: the replay lag across two clocks', () => {
  it('never reports a negative lag', async () => {
    h.probe = 't|streaming|f|-2.5\n';
    const live = (await fleetReplica.getFleetReplicaStatus(bot())).live!;
    expect(live.replayLagSeconds).toBe(0);
    expect(live.clockSkewSeconds).toBeUndefined();
  });

  it('withholds the lag and names the skew when the clocks disagree past the bound', async () => {
    h.probe = 't|streaming|f|-40\n';
    const live = (await fleetReplica.getFleetReplicaStatus(bot())).live!;
    expect(live.replayLagSeconds).toBeNull();
    expect(live.clockSkewSeconds).toBe(40);
    expect(live.caughtUp).toBe(false);
  });

  it('keeps a positive lag as read', async () => {
    h.probe = 't|streaming|f|12.5\n';
    expect((await fleetReplica.getFleetReplicaStatus(bot())).live!.replayLagSeconds).toBe(12.5);
  });
});

describe('FU-7c: a slot fact received in the future is not fresh', () => {
  it('counts a fact from the future as not fresh', () => {
    const now = Date.now();
    expect(fleetReplica.slotFactFresh(now - 1000, now)).toBe(true);
    expect(fleetReplica.slotFactFresh(now - 10 * 60_000, now)).toBe(false);
    expect(fleetReplica.slotFactFresh(now + 60_000, now)).toBe(false);
    expect(fleetReplica.slotFactFresh(Number.NaN, now)).toBe(false);
    expect(fleetReplica.slotFactFresh(undefined, now)).toBe(false);
  });
});

describe('FU-7c: the re-seed ignores a slot fact received in the future', () => {
  const PEM = '-----BEGIN CERTIFICATE-----\nZmFrZQ==\n-----END CERTIFICATE-----';
  const leftBehindFact = (receivedAt: number) => ({
    running: true,
    standbySlot: { slotName: REPLICA.slot, walStatus: 'reserved', observedAt: Date.now(), receivedAt, sourceAt: Date.now(), fromNodeId: 'n2', fromTerm: 2, sourceIsCurrentMaster: false },
  });
  it('the re-seed refuses a repoint on a future-dated former-master fact', async () => {
    h.hooks = true;
    h.probe = 't|streaming|f|1\n';
    h.facts = { ...leftBehindFact(Date.now() + 60_000), copyBlockCurrent: true, copyBlock: { dsn: 'postgresql://replicator:fakepass@other.invalid:5433/smdb', cert: PEM } };
    const res = await fleetReplica.reseedStandby(bot(), 'operator');
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/does not report its source as a former master/);
  });
});
