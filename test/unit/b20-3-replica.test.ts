import { afterAll, describe, expect, it, vi } from 'vitest';

const tmp = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'b20-3r-'));
  process.env.DATA_DIR = dir;
  return { dir };
});

vi.mock('../../src/webui/server', () => ({ broadcastToClients: () => {} }));
const retire = vi.hoisted(() => ({ result: null as null | { success: boolean; error?: string; volumeRemoved?: boolean } }));
vi.mock('../../src/docker/containerManager', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/docker/containerManager')>();
  return { ...real, retireFleetDbSidecar: async (id: string) => retire.result ?? real.retireFleetDbSidecar(id) };
});

import * as fs from 'fs';
import * as path from 'path';
import * as containerManager from '../../src/docker/containerManager';
import * as fleetReplica from '../../src/instance/fleetReplica';

const PEM = '-----BEGIN CERTIFICATE-----\nZmFrZQ==\n-----END CERTIFICATE-----';
const DSN = 'postgresql://replicator:fakepass@primary.invalid:5433/smdb';
const FLEET_URL = 'https://example.invalid/fake/super-modular-discord-bot';
const REPLICA = {
  containerName: 'bot1-fleet-postgres-replica', volume: 'bot1-fleet-postgres-replica-data', slot: 'fleet_standby_b1',
  primaryHost: 'primary.invalid', primaryPort: 5433, publicHost: 'standby.invalid', hostPort: 5440, certHost: 'standby.invalid',
  user: 'smdb', db: 'smdb',
};

const registryPath = path.join(tmp.dir, 'instances.json');
const writeRegistry = (over: Record<string, unknown> = {}): void => {
  fs.writeFileSync(registryPath, JSON.stringify({
    instances: {
      b1: {
        id: 'b1', sanitizedName: 'bot1', displayName: 'Bot 1', titleName: 'Bot 1', status: 'stopped',
        sourceType: 'git', sourceUrl: FLEET_URL, envVars: { BOT_NODE_ROLE: 'master' },
        createdAt: '2026-10-24T00:00:00.000Z', updatedAt: '2026-10-24T00:00:00.000Z',
        ...over,
      },
    },
  }));
};
const bot = () => containerManager.getBot('b1')!;

afterAll(() => { fs.rmSync(tmp.dir, { recursive: true, force: true }); });

describe('the automatic re-seed outlook names the attempts left and when none remain', () => {
  const now = 1_800_000_000_000;
  const at = (autoReseed: unknown, extra: Record<string, unknown> = {}) => ({ ...bot(), fleetDbReplica: { ...REPLICA, autoReseed }, ...extra }) as any;

  it('counts the attempts left and the next allowed time', () => {
    writeRegistry();
    const out = fleetReplica.autoReseedOutlook(at({ attempts: 1, lastAttemptAt: now - 60_000, trigger: 'automatic', lastError: 'x' }), now);
    expect(out).toEqual({ remaining: fleetReplica.AUTO_RESEED_MAX_ATTEMPTS - 1, nextAt: now - 60_000 + 30 * 60_000, none: null });
  });

  it('says nothing retries once the cap is reached', () => {
    writeRegistry();
    const out = fleetReplica.autoReseedOutlook(at({ attempts: fleetReplica.AUTO_RESEED_MAX_ATTEMPTS, lastAttemptAt: now, trigger: 'automatic', lastError: 'x' }), now);
    expect(out.remaining).toBe(0);
    expect(out.none).toMatch(/stopped after 3 attempts/);
  });

  it('says nothing retries a cancelled seed', () => {
    writeRegistry();
    const out = fleetReplica.autoReseedOutlook(at({ attempts: 1, lastAttemptAt: now, trigger: 'automatic' }, { fleetDbReplicaSeed: { purpose: 'reseed-standby', parked: true, cancelled: true } }), now);
    expect(out.none).toMatch(/cancelled/);
  });

});

describe('Provision after a re-seed retired this node\'s own database', () => {
  it('passes the role gate for a node whose database the re-seed retired', () => {
    writeRegistry({ fleetOwnDbRetiredAt: '2026-10-24T00:00:00.000Z' });
    const res = fleetReplica.provisionFleetReplica(bot(), DSN, PEM, 'standby.invalid', 5440);
    expect(res.error ?? '').not.toMatch(/A replica belongs beside a fleet worker/);
  });

  it('a re-seed retire that removed the database opens the role gate', async () => {
    writeRegistry();
    retire.result = { success: true };
    await fleetReplica.retireStaleOwnDb('b1');
    retire.result = null;
    expect(bot().fleetOwnDbRetiredAt).toBeTruthy();
    const res = fleetReplica.provisionFleetReplica(bot(), DSN, PEM, 'standby.invalid', 5440);
    expect(res.error ?? '').not.toMatch(/A replica belongs beside a fleet worker/);
  });

  it('a retire that failed after removing the volume still records the database retired', async () => {
    writeRegistry();
    retire.result = { success: false, error: 'compose strip failed', volumeRemoved: true };
    const out = await fleetReplica.retireStaleOwnDb('b1');
    retire.result = null;
    expect(out.success).toBe(false);
    expect(bot().fleetOwnDbRetiredAt).toBeTruthy();
  });

  it('a retire that refused before touching the volume leaves the flag unset', async () => {
    writeRegistry();
    retire.result = { success: false, error: 'database volume v kept: shared; nothing was removed' };
    await fleetReplica.retireStaleOwnDb('b1');
    retire.result = null;
    expect(bot().fleetOwnDbRetiredAt).toBeUndefined();
    const res = fleetReplica.provisionFleetReplica(bot(), DSN, PEM, 'standby.invalid', 5440);
    expect(res.error).toMatch(/A replica belongs beside a fleet worker/);
  });

  it('still refuses a master that retired nothing', () => {
    writeRegistry();
    const res = fleetReplica.provisionFleetReplica(bot(), DSN, PEM, 'standby.invalid', 5440);
    expect(res.error).toMatch(/A replica belongs beside a fleet worker/);
  });

  it('a node with its own database again is refused as the primary side', () => {
    writeRegistry({ fleetOwnDbRetiredAt: '2026-10-24T00:00:00.000Z', fleetDb: { containerName: 'bot1-fleet-postgres', user: 'smdb', db: 'smdb', volume: 'v' } });
    const res = fleetReplica.provisionFleetReplica(bot(), DSN, PEM, 'standby.invalid', 5440);
    expect(res.error).toMatch(/hosts the fleet database itself/);
  });
  it('an adopt of the promoted copy clears the mark, so a later decommission does not open the gate', () => {
    writeRegistry({ fleetOwnDbRetiredAt: '2026-10-24T00:00:00.000Z', fleetDbReplica: REPLICA });
    expect(containerManager.adoptFleetDbReplicaAsPrimary('b1').success).toBe(true);
    expect(bot().fleetOwnDbRetiredAt).toBeUndefined();
    const stored = JSON.parse(fs.readFileSync(registryPath, 'utf-8'));
    expect(stored.instances.b1.fleetOwnDbRetiredAt).toBeUndefined();
    delete stored.instances.b1.fleetDb;
    fs.writeFileSync(registryPath, JSON.stringify(stored));
    const res = fleetReplica.provisionFleetReplica(bot(), DSN, PEM, 'standby.invalid', 5440);
    expect(res.error).toMatch(/A replica belongs beside a fleet worker/);
  });
});
