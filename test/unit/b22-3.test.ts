import { describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'b22-3-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return { dir };
});
vi.mock('../../src/webui/server', () => ({ broadcastToClients: () => {} }));

import * as fs from 'fs';
import * as path from 'path';
import * as containerManager from '../../src/docker/containerManager';
import { parseDocument } from 'yaml';
import {
  addFleetPostgresReplicaService,
  addFleetPostgresService,
  removeFleetPostgresReplicaService,
  removeFleetPostgresService,
} from '../../src/templates/pcsProcessing';

const bot = { id: 'b1', displayName: 'Bot One', sanitizedName: 'bot1' } as any;
const replica = { containerName: 'pgr', volume: 'vr', hostPort: 15432, user: 'u', db: 'd' };

function services(content: string): Record<string, Record<string, any>> {
  return (parseDocument(content).toJSON() as any).services;
}

describe('the app depends on the standby database so compose down stops the app first', () => {
  it('a plain app gains the dependency', () => {
    const out = services(addFleetPostgresReplicaService('services:\n  app:\n    image: example/app:1\n', bot, replica));
    expect(out.app.depends_on).toEqual(['fleet-postgres-replica']);
    expect(out['fleet-postgres-replica'].depends_on).toBeUndefined();
  });

  it('an authored list keeps its entries and gains the dependency once', () => {
    const base = 'services:\n  app:\n    image: example/app:1\n    depends_on: [cache]\n  cache:\n    image: redis:7\n';
    const once = addFleetPostgresReplicaService(base, bot, replica);
    const out = services(addFleetPostgresReplicaService(once, bot, replica));
    expect(out.app.depends_on).toEqual(['cache', 'fleet-postgres-replica']);
  });

  it('an authored map keeps its conditions and gains the dependency', () => {
    const base = 'services:\n  app:\n    image: example/app:1\n    depends_on:\n      cache:\n        condition: service_healthy\n  cache:\n    image: redis:7\n';
    const out = services(addFleetPostgresReplicaService(base, bot, replica));
    expect(out.app.depends_on).toEqual({ cache: { condition: 'service_healthy' }, 'fleet-postgres-replica': { condition: 'service_started' } });
  });

  it('removing the standby drops the dependency and keeps the authored ones', () => {
    const base = 'services:\n  app:\n    image: example/app:1\n    depends_on: [cache]\n  cache:\n    image: redis:7\n';
    const out = services(removeFleetPostgresReplicaService(addFleetPostgresReplicaService(base, bot, replica)));
    expect(out['fleet-postgres-replica']).toBeUndefined();
    expect(out.app.depends_on).toEqual(['cache']);
    const bare = services(removeFleetPostgresReplicaService(addFleetPostgresReplicaService('services:\n  app:\n    image: example/app:1\n', bot, replica)));
    expect(bare.app.depends_on).toBeUndefined();
  });

  it('removing both sidecars leaves no dangling dependency', () => {
    const base = 'services:\n  app:\n    image: example/app:1\n';
    const both = addFleetPostgresReplicaService(addFleetPostgresService(base, bot, { containerName: 'pg', volume: 'v', password: 'p', user: 'u', db: 'd' }), bot, replica);
    expect(services(both).app.depends_on).toEqual(['fleet-postgres', 'fleet-postgres-replica']);
    const out = services(removeFleetPostgresReplicaService(removeFleetPostgresService(both)));
    expect(out.app.depends_on).toBeUndefined();
  });
});

describe('adopting the standby rewrites the deployed compose at once', () => {
  it('a compose deployed without the dependency gains it on adopt', () => {
    const botDir = path.join(h.dir, 'bots', 'b1');
    fs.mkdirSync(botDir, { recursive: true });
    fs.writeFileSync(path.join(h.dir, 'instances.json'), JSON.stringify({
      instances: {
        b1: {
          id: 'b1', sanitizedName: 'bot1', displayName: 'Bot 1', titleName: 'Bot 1', status: 'stopped',
          sourceType: 'docker-image', envVars: {}, fleetDbReplica: replica,
          createdAt: '2026-10-22T00:00:00.000Z', updatedAt: '2026-10-22T00:00:00.000Z',
        },
      },
    }));
    const composePath = path.join(botDir, 'docker-compose.yml');
    fs.writeFileSync(composePath, 'services:\n  app:\n    image: example/app:1\n    depends_on: [cache]\n  cache:\n    image: redis:7\n  fleet-postgres-replica:\n    image: postgres:16\n    container_name: pgr\n');
    expect(containerManager.adoptFleetDbReplicaAsPrimary('b1')).toEqual({ success: true });
    const out = services(fs.readFileSync(composePath, 'utf-8'));
    expect(out.app.depends_on).toEqual(['cache', 'fleet-postgres-replica']);
    expect(out['fleet-postgres-replica'].container_name).toBe('pgr');
  });
});
