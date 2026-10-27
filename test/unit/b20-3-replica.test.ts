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

import * as fs from 'fs';
import * as path from 'path';
import * as containerManager from '../../src/docker/containerManager';
import * as fleetReplica from '../../src/instance/fleetReplica';

const PEM = '-----BEGIN CERTIFICATE-----\nZmFrZQ==\n-----END CERTIFICATE-----';
const DSN = 'postgresql://replicator:fakepass@primary.invalid:5433/smdb';
const FLEET_URL = 'https://example.invalid/fake/super-modular-discord-bot';

const registryPath = path.join(tmp.dir, 'instances.json');
const writeRegistry = (over: Record<string, unknown> = {}): void => {
  fs.writeFileSync(registryPath, JSON.stringify({
    instances: {
      b1: {
        id: 'b1', sanitizedName: 'bot1', displayName: 'Bot 1', titleName: 'Bot 1', status: 'stopped',
        sourceType: 'git', sourceUrl: FLEET_URL, envVars: {},
        createdAt: '2026-10-24T00:00:00.000Z', updatedAt: '2026-10-24T00:00:00.000Z',
        ...over,
      },
    },
  }));
};
const bot = () => containerManager.getBot('b1')!;

afterAll(() => { fs.rmSync(tmp.dir, { recursive: true, force: true }); });

describe('Provision on a node that hosts its own database', () => {
  it('a node with its own database is refused as the primary side', () => {
    writeRegistry({ fleetDb: { containerName: 'bot1-fleet-postgres', user: 'smdb', db: 'smdb', volume: 'v' } });
    const res = fleetReplica.provisionFleetReplica(bot(), DSN, PEM, 'standby.invalid', 5440);
    expect(res.error).toMatch(/hosts the fleet database itself/);
  });
});
