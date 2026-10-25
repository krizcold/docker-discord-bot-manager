import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'b22-1-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return {
    dir,
    spawns: [] as string[][],
    rms: [] as string[],
    running: 'true' as 'true' | 'false' | 'error',
    probeOk: true,
    onRm: null as null | ((name: string) => void),
    onPull: null as null | (() => void),
    apply: { success: true } as { success: boolean; error?: string },
    applied: 0,
    marked: [] as string[],
    hooks: false,
    posture: null as null | (() => Promise<unknown>),
    promote: null as null | (() => Promise<unknown>),
    removeGate: null as null | Promise<void>,
    removing: false,
    volume: 'absent' as 'absent' | 'exists',
  };
});

// A fake docker. inspect answers h.running, exec answers a streaming standby,
// rm -f calls h.onRm, and every docker run exits 0 except the primary probe
// when h.probeOk is false.
vi.mock('child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('child_process')>();
  const { EventEmitter } = await import('events');
  const { PassThrough } = await import('stream');
  const execFile = (_cmd: string, args: string[], opts: any, cb?: any) => {
    const done = typeof opts === 'function' ? opts : cb;
    if (args[0] === 'inspect') {
      if (h.running === 'error') return done(new Error('daemon'), '', 'Cannot connect to the Docker daemon');
      return done(null, `${h.running}\n`, '');
    }
    if (args[0] === 'pull') h.onPull?.();
    if (args[0] === 'exec') return done(null, 't|streaming|t|0\n', '');
    if (args[0] === 'rm') { h.rms.push(args[2]); h.onRm?.(args[2]); return done(null, '', ''); }
    if (args[0] === 'volume' && args[1] === 'inspect') return done(new Error('fail'), '', 'Error: No such volume');
    done(null, '', '');
  };
  const exec = (_cmd: string, opts: any, cb?: any) => {
    const done = typeof opts === 'function' ? opts : cb;
    done(null, { stdout: '', stderr: '' });
  };
  const spawn = (_cmd: string, args: string[]) => {
    h.spawns.push(args);
    const child: any = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.kill = () => {};
    const probe = args.includes('SELECT pg_is_in_recovery()');
    setTimeout(() => {
      child.stdout.end(probe && h.probeOk ? 'f\n' : '');
      child.stderr.end(probe && !h.probeOk ? 'psql: error: connection refused (fake)\n' : '');
      setTimeout(() => child.emit('close', probe && !h.probeOk ? 2 : 0), 1);
    }, 1);
    return child;
  };
  // dockerClient.volumeState runs the CLI synchronously; without this a row answers whatever the test machine's docker says.
  const execFileSync = (cmd: string, args: string[], opts: any) => {
    if (args[0] === 'volume' && args[1] === 'inspect') {
      if (h.volume === 'exists') return '[]';
      throw Object.assign(new Error('fail'), { stderr: 'Error: No such volume' });
    }
    return real.execFileSync(cmd, args, opts);
  };
  return { ...real, execFile, execFileSync, exec, spawn, default: { ...real, execFile, execFileSync, exec, spawn } };
});
vi.mock('../../src/docker/containerManager', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/docker/containerManager')>()),
  deployedComposeExists: () => true,
  applyFleetDbReplicaService: async () => { h.applied++; return h.apply; },
  markPendingApplyIfRunning: async (id: string) => { h.marked.push(id); },
  removeFleetDbReplicaService: async () => {
    h.removing = true;
    if (h.removeGate) await h.removeGate;
    return { success: true };
  },
}));
vi.mock('../../src/instance/appHookClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/instance/appHookClient')>()),
  hasAppHooks: () => h.hooks,
}));
vi.mock('../../src/instance/appLifecycle', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/instance/appLifecycle')>()),
  capabilityRefusal: () => null,
  getAppFacts: async () => ({ success: true, facts: { running: true, copyBlockCurrent: true, copyBlock: { dsn: 'postgresql://replicator:fakepass@primary.invalid:5433/smdb', cert: PEM } } }),
  postureFromRead: () => ({ read: 'ok', posture: null }),
  readStandInPosture: async () => (h.posture ? h.posture() : { read: 'none' }),
  transfer: async () => (h.promote ? h.promote() : { success: true }),
}));
vi.mock('../../src/casaos/detector', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/casaos/detector')>()),
  getDeploymentMode: async () => 'docker',
}));

const PEM = '-----BEGIN CERTIFICATE-----\nZmFrZQ==\n-----END CERTIFICATE-----';

import * as fs from 'fs';
import * as path from 'path';
import YAML from 'yaml';
import * as containerManager from '../../src/docker/containerManager';
import { cancelReplicaSeed, parkInterruptedReplicaSeeds, provisionFleetReplica, removeFleetReplica, reseedStandby } from '../../src/instance/fleetReplica';
import { transferSide } from '../../src/instance/fleetTransfer';

const cancel = cancelReplicaSeed as unknown as (instance: any, expect?: Record<string, unknown>) => Promise<any>;

const REPLICA = {
  containerName: 'bot1-fleet-postgres-replica', volume: 'bot1-fleet-postgres-replica-data', slot: 'fleet_standby_b1',
  primaryHost: 'primary.invalid', primaryPort: 5433, publicHost: 'standby.invalid', hostPort: 5440, certHost: 'standby.invalid',
  user: 'smdb', db: 'smdb',
};
const seedOf = (startedAt: number, extra: Record<string, unknown> = {}) => ({
  purpose: 'reseed-standby', phase: 'starting', startedAt, updatedAt: startedAt,
  publicHost: 'standby.invalid', hostPort: 5440, primaryHost: 'primary.invalid', primaryPort: 5433, slot: 'fleet_standby_b1',
  ...extra,
});

const writeRegistry = (b1: Record<string, unknown> = {}, others: Record<string, unknown> = {}): void => {
  fs.writeFileSync(path.join(h.dir, 'instances.json'), JSON.stringify({
    instances: {
      b1: {
        id: 'b1', sanitizedName: 'bot1', displayName: 'Bot 1', titleName: 'Bot 1', status: 'running',
        sourceType: 'git', sourceUrl: 'https://example.invalid/fake/super-modular-discord-bot',
        envVars: { BOT_NODE_ROLE: 'co-worker' },
        createdAt: '2026-10-24T00:00:00.000Z', updatedAt: '2026-10-24T00:00:00.000Z',
        ...b1,
      },
      ...others,
    },
  }));
};

const bot = () => containerManager.getBot('b1')!;
const waitFor = async (cond: () => boolean): Promise<void> => {
  for (let i = 0; i < 300 && !cond(); i++) await new Promise((r) => setTimeout(r, 10));
};
const wiped = () => h.spawns.some((a) => a.some((s) => s.includes('rm -rf')));

beforeEach(async () => {
  // A run an earlier row left going must release the instance first.
  await waitFor(() => containerManager.isBotBusy('b1') === null);
  fs.rmSync(path.join(h.dir, 'bots'), { recursive: true, force: true });
  fs.mkdirSync(path.join(h.dir, 'bots', 'b1', 'env'), { recursive: true });
  h.spawns.length = 0;
  h.rms.length = 0;
  h.running = 'true';
  h.probeOk = true;
  h.onRm = null;
  h.onPull = null;
  h.apply = { success: true };
  h.applied = 0;
  h.marked.length = 0;
  h.hooks = false;
  h.posture = null;
  h.promote = null;
  h.removeGate = null;
  h.removing = false;
  h.volume = 'absent';
  writeRegistry();
});

afterAll(() => {
  fs.rmSync(h.dir, { recursive: true, force: true });
});

describe('R16-40: a re-seed over a whole parked copy does not inherit cleared', () => {
  it('starts uncommitted and says nothing was changed when it stops before the wipe', async () => {
    h.hooks = true;
    h.probeOk = false;
    writeRegistry({ fleetDbReplica: { ...REPLICA, seededBy: 1000 }, fleetDbReplicaSeed: seedOf(1000, { parked: true, committed: true, lastError: 'the manager restarted during the seed (phase starting)' }) });
    const res = await reseedStandby(bot(), 'operator');
    expect(res).toMatchObject({ success: true });
    expect(bot().fleetDbReplicaSeed?.committed).toBeUndefined();
    await waitFor(() => bot().fleetDbReplicaSeed?.parked === true);
    expect(bot().fleetDbReplicaSeed?.lastError).toContain('so nothing has been changed');
    expect(wiped()).toBe(false);
  });

  it('still inherits it from a copy the record marks cleared', async () => {
    h.hooks = true;
    h.probeOk = false;
    writeRegistry({ fleetDbReplica: { ...REPLICA, copyCleared: true }, fleetDbReplicaSeed: seedOf(1000, { phase: 'seeding', parked: true, committed: true, lastError: 'pg_basebackup failed' }) });
    const res = await reseedStandby(bot(), 'operator');
    expect(res).toMatchObject({ success: true });
    expect(bot().fleetDbReplicaSeed?.committed).toBe(true);
    await waitFor(() => bot().fleetDbReplicaSeed?.parked === true);
  });
});

describe('R17-12 and R16-37: a seed the restart caught at starting with its standby on record', () => {
  it('a provision is settled at boot: the service is applied, the app marked, the seed cleared', async () => {
    writeRegistry({ fleetDbReplica: { ...REPLICA, seededBy: 5000 }, fleetDbReplicaSeed: seedOf(5000, { purpose: 'provision', committed: true }) });
    await parkInterruptedReplicaSeeds();
    expect(h.applied).toBe(1);
    expect(h.marked).toEqual(['b1']);
    expect(bot().fleetDbReplicaSeed).toBeUndefined();
    expect(bot().fleetDbReplica?.seededBy).toBe(5000);
  });

  it('a re-seed is settled at boot and its ledger records the success', async () => {
    writeRegistry({ fleetDbReplica: { ...REPLICA, seededBy: 5000, autoReseed: { attempts: 1, lastAttemptAt: 4000, trigger: 'automatic' } }, fleetDbReplicaSeed: seedOf(5000, { committed: true }) });
    await parkInterruptedReplicaSeeds();
    expect(h.applied).toBe(1);
    expect(bot().fleetDbReplicaSeed).toBeUndefined();
    expect(bot().fleetDbReplica?.autoReseed?.attempts).toBe(0);
    expect(bot().fleetDbReplica?.autoReseed?.lastSuccessAt).toBeTypeOf('number');
  });

  it('a failed boot start parks the seed with the reason and keeps the record', async () => {
    h.apply = { success: false, error: 'fake apply failure' };
    writeRegistry({ fleetDbReplica: { ...REPLICA, seededBy: 5000 }, fleetDbReplicaSeed: seedOf(5000, { purpose: 'provision', committed: true }) });
    await parkInterruptedReplicaSeeds();
    expect(bot().fleetDbReplicaSeed?.parked).toBe(true);
    expect(bot().fleetDbReplicaSeed?.lastError).toContain('fake apply failure');
    expect(bot().fleetDbReplica?.seededBy).toBe(5000);
    expect(h.marked).toEqual([]);
  });

  it('a record another seed built is not taken for this one', async () => {
    writeRegistry({ fleetDbReplica: { ...REPLICA, seededBy: 4000 }, fleetDbReplicaSeed: seedOf(5000, { committed: true }) });
    await parkInterruptedReplicaSeeds();
    expect(h.applied).toBe(0);
    expect(bot().fleetDbReplicaSeed?.parked).toBe(true);
  });
});

describe('R14-26, R14-27, R17-12: Cancel and Dismiss carry the run and the state they showed', () => {
  it('a Dismiss of a whole provision copy says it is kept and that its container runs', async () => {
    writeRegistry({ fleetDbReplica: { ...REPLICA, seededBy: 5000 }, fleetDbReplicaSeed: seedOf(5000, { purpose: 'provision', parked: true, committed: true, lastError: 'x' }) });
    const asked = await cancel(bot(), { startedAt: 5000, parked: true });
    expect(asked.success).toBe(false);
    expect(asked.needsConfirm).toBe(true);
    expect(asked.error).toContain('kept on record');
    expect(asked.error).toContain('container is running');
    expect(asked.error).not.toContain('discarded');
    expect(bot().fleetDbReplicaSeed?.startedAt).toBe(5000);
    const done = await cancel(bot(), { startedAt: 5000, parked: true, committed: true, confirm: true });
    expect(done).toMatchObject({ success: true, dismissed: true });
    expect(bot().fleetDbReplicaSeed).toBeUndefined();
    expect(bot().fleetDbReplica?.seededBy).toBe(5000);
  });

  it('a whole re-seed copy whose container docker cannot read says so', async () => {
    h.running = 'error';
    writeRegistry({ fleetDbReplica: { ...REPLICA, seededBy: 5000 }, fleetDbReplicaSeed: seedOf(5000, { parked: true, committed: true, lastError: 'x' }) });
    const asked = await cancel(bot(), { startedAt: 5000, parked: true });
    expect(asked.needsConfirm).toBe(true);
    expect(asked.error).toContain("can't confirm");
    expect(asked.error).not.toContain('only its container failed to start');
  });

  it('a Dismiss from a view of an older run is refused and the new run is kept', async () => {
    writeRegistry({ fleetDbReplica: { ...REPLICA }, fleetDbReplicaSeed: seedOf(2000, { phase: 'preparing' }) });
    const res = await cancel(bot(), { startedAt: 1000, parked: true });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/since this view loaded/);
    expect(bot().fleetDbReplicaSeed?.startedAt).toBe(2000);
    expect(bot().fleetDbReplicaSeed?.cancelRequested).toBeUndefined();
    expect(h.rms).toEqual([]);
  });

  it('a run that replaces the parked one during the sweep keeps its record', async () => {
    writeRegistry({ fleetDbReplica: { ...REPLICA }, fleetDbReplicaSeed: seedOf(6000, { phase: 'preparing', parked: true, lastError: 'x' }) });
    h.onRm = () => {
      h.onRm = null;
      containerManager.updateInstanceFleetDbReplicaSeed('b1', seedOf(7000, { phase: 'preparing' }) as any);
    };
    const res = await cancel(bot(), { startedAt: 6000, parked: true });
    expect(res.success).toBe(false);
    expect(bot().fleetDbReplicaSeed?.startedAt).toBe(7000);
    expect(bot().fleetDbReplicaSeed?.parked).toBeUndefined();
  });

  it('a live Cancel confirmed as uncommitted is asked again once the run has committed', async () => {
    writeRegistry({ fleetDbReplica: { ...REPLICA, copyCleared: true }, fleetDbReplicaSeed: seedOf(8000, { phase: 'seeding', committed: true }) });
    const res = await cancel(bot(), { startedAt: 8000, parked: false, committed: false, confirm: true });
    expect(res.success).toBe(false);
    expect(res.needsConfirm).toBe(true);
    expect(res.error).toContain('already been cleared');
    expect(bot().fleetDbReplicaSeed?.cancelRequested).toBeUndefined();
  });

  it('a live Cancel of an uncommitted run asks first and says nothing was deleted', async () => {
    writeRegistry({ fleetDbReplica: { ...REPLICA }, fleetDbReplicaSeed: seedOf(8000, { phase: 'seeding' }) });
    const asked = await cancel(bot(), { startedAt: 8000, parked: false });
    expect(asked.needsConfirm).toBe(true);
    expect(asked.error).toContain('Nothing has been deleted by this run yet');
    expect(bot().fleetDbReplicaSeed?.cancelRequested).toBeUndefined();
    const done = await cancel(bot(), { startedAt: 8000, parked: false, committed: false, confirm: true });
    expect(done.success).toBe(true);
    expect(bot().fleetDbReplicaSeed?.cancelRequested).toBe(true);
  });
});

describe('R9-23, R9-25, R9-26: Remove replica refuses what is in flight', () => {
  it('refuses while another operation holds the instance', async () => {
    writeRegistry({ fleetDbReplica: { ...REPLICA } });
    let release!: () => void;
    const held = containerManager.withExternalBotOp('b1', 'build', () => new Promise<void>((r) => { release = r; }));
    try {
      const res = await removeFleetReplica(bot());
      expect(res.success).toBe(false);
      expect(res.error).toContain("'build'");
      expect(bot().fleetDbReplica?.containerName).toBe(REPLICA.containerName);
    } finally {
      release();
      await held;
    }
  });

  it('refuses while a transfer run is live', async () => {
    writeRegistry({ fleetDbReplica: { ...REPLICA }, fleetTransfer: { phase: 'promoting', startedAt: 1, updatedAt: 1, retireOldMaster: false } });
    const res = await removeFleetReplica(bot());
    expect(res.success).toBe(false);
    expect(bot().fleetDbReplica?.containerName).toBe(REPLICA.containerName);
  });

  it('refuses while a Transfer promotes this copy in the same request', async () => {
    h.hooks = true;
    writeRegistry({ fleetDbReplica: { ...REPLICA } });
    let during: any = null;
    h.promote = async () => { during = await removeFleetReplica(bot()); return { success: true }; };
    h.posture = async () => ({ read: 'ok', posture: null });
    await transferSide(bot(), {});
    expect(during?.success).toBe(false);
    expect(bot().fleetDbReplica?.containerName).toBe(REPLICA.containerName);
  });

  it('refuses a seed that started while it read the posture, and keeps both records', async () => {
    h.hooks = true;
    writeRegistry({ fleetDbReplica: { ...REPLICA } });
    h.posture = async () => {
      containerManager.updateInstanceFleetDbReplicaSeed('b1', seedOf(9000, { phase: 'preparing' }) as any);
      return { read: 'ok', posture: null };
    };
    const res = await removeFleetReplica(bot());
    expect(res.success).toBe(false);
    expect(bot().fleetDbReplica?.containerName).toBe(REPLICA.containerName);
    expect(bot().fleetDbReplicaSeed?.startedAt).toBe(9000);
  });
});

describe('R9-23: a removal holds the instance until it ends', () => {
  it('refuses a re-seed started while the standby service is being removed', async () => {
    h.hooks = true;
    h.posture = async () => ({ read: 'ok', posture: null });
    writeRegistry({ fleetDbReplica: { ...REPLICA } });
    let release!: () => void;
    h.removeGate = new Promise<void>((r) => { release = r; });
    const removing = removeFleetReplica(bot());
    await waitFor(() => h.removing);
    const reseed = await reseedStandby(bot(), 'operator');
    release();
    const res = await removing;
    await waitFor(() => containerManager.isBotBusy('b1') === null);
    expect(reseed.success).toBe(false);
    expect(reseed.error).toContain("'replica-remove'");
    expect(res.success).toBe(true);
    expect(bot().fleetDbReplica ?? null).toBeNull();
    expect(bot().fleetDbReplicaSeed ?? null).toBeNull();
    expect(wiped()).toBe(false);
    expect(containerManager.isBotBusy('b1')).toBeNull();
  });
});

describe('R9-25: a start drops a standby service no record names', () => {
  const composePath = () => path.join(h.dir, 'bots', 'b1', 'docker-compose.yml');
  const writeCompose = (containerName: string) => fs.writeFileSync(composePath(), YAML.stringify({
    services: {
      app: { image: 'fake/app:1', depends_on: ['fleet-postgres-replica'] },
      'fleet-postgres-replica': { image: 'postgres:16-alpine', container_name: containerName, volumes: [{ type: 'volume', source: 'fleet-postgres-replica-data', target: '/var/lib/postgresql/data' }] },
    },
    volumes: { 'fleet-postgres-replica-data': { name: 'bot1-fleet-postgres-replica-data' } },
  }));

  it('removes the service and the app dependency when the record is gone', () => {
    writeCompose(REPLICA.containerName);
    expect(containerManager.syncComposeEnvVars(bot(), composePath())).toBeNull();
    const out = YAML.parse(fs.readFileSync(composePath(), 'utf8'));
    expect(out.services['fleet-postgres-replica']).toBeUndefined();
    expect(JSON.stringify(out.services.app.depends_on ?? [])).not.toContain('fleet-postgres-replica');
  });

  it('keeps the service of a standby on record, and of an adopted copy', () => {
    writeRegistry({ fleetDbReplica: { ...REPLICA } });
    writeCompose(REPLICA.containerName);
    containerManager.syncComposeEnvVars(bot(), composePath());
    expect(YAML.parse(fs.readFileSync(composePath(), 'utf8')).services['fleet-postgres-replica']).toBeDefined();
    writeRegistry({ fleetDb: { containerName: REPLICA.containerName, user: 'smdb', db: 'smdb', volume: REPLICA.volume } });
    writeCompose(REPLICA.containerName);
    containerManager.syncComposeEnvVars(bot(), composePath());
    expect(YAML.parse(fs.readFileSync(composePath(), 'utf8')).services['fleet-postgres-replica']).toBeDefined();
  });
});

describe('T-FDBVOLw: a seed never clears a volume another instance declares', () => {
  const b2 = (extra: Record<string, unknown>) => ({
    b2: { id: 'b2', sanitizedName: 'bot2', displayName: 'Bot 2', titleName: 'Bot 2', status: 'stopped', sourceType: 'git', sourceUrl: 'https://example.invalid/other', createdAt: 'x', updatedAt: 'x', ...extra },
  });

  const DSN = 'postgresql://replicator:fakepass@primary.invalid:5433/smdb';
  const refusedAtRequest = async (res: any, text: string): Promise<void> => {
    expect(res.success).toBe(false);
    expect(res.needsConfirm).toBeUndefined();
    expect(res.error).toContain(text);
    expect(res.error).toContain('nothing was started');
    await new Promise((r) => setTimeout(r, 50));
    expect(bot().fleetDbReplicaSeed).toBeUndefined();
    expect(h.spawns.length).toBe(0);
    expect(wiped()).toBe(false);
  };

  it('refuses at the request, naming the other instance, and leaves the volume alone', async () => {
    h.volume = 'exists';
    writeRegistry({}, b2({ projectVolumes: [REPLICA.volume] }));
    await refusedAtRequest(provisionFleetReplica(bot(), DSN, PEM, 'standby.invalid', 5440, true), 'Bot 2');
  });

  it("refuses at the request with can't confirm when another instance's compose cannot be read", async () => {
    h.volume = 'exists';
    writeRegistry({}, b2({}));
    fs.mkdirSync(path.join(h.dir, 'bots', 'b2', 'docker-compose.yml'), { recursive: true });
    await refusedAtRequest(provisionFleetReplica(bot(), DSN, PEM, 'standby.invalid', 5440, true), "can't confirm");
  });

  it('a confirm naming the volume does not override the refusal', async () => {
    h.volume = 'exists';
    writeRegistry({}, b2({ projectVolumes: [REPLICA.volume] }));
    await refusedAtRequest(provisionFleetReplica(bot(), DSN, PEM, 'standby.invalid', 5440, true, { confirmVolume: REPLICA.volume }), 'Bot 2');
  });

  it('refuses at the request even when the volume is absent', async () => {
    writeRegistry({}, b2({ projectVolumes: [REPLICA.volume] }));
    await refusedAtRequest(provisionFleetReplica(bot(), DSN, PEM, 'standby.invalid', 5440, true), 'Bot 2');
  });

  it('stops the running seed before the wipe when another instance comes to declare the volume', async () => {
    h.onPull = () => {
      const file = path.join(h.dir, 'instances.json');
      const reg = JSON.parse(fs.readFileSync(file, 'utf8'));
      Object.assign(reg.instances, b2({ projectVolumes: [REPLICA.volume] }));
      fs.writeFileSync(file, JSON.stringify(reg));
    };
    const res = await provisionFleetReplica(bot(), DSN, PEM, 'standby.invalid', 5440, true);
    expect(res.success).toBe(true);
    await waitFor(() => bot().fleetDbReplicaSeed?.parked === true);
    expect(bot().fleetDbReplicaSeed?.lastError).toContain('Bot 2');
    expect(bot().fleetDbReplicaSeed?.committed).toBeUndefined();
    expect(wiped()).toBe(false);
  });
});
