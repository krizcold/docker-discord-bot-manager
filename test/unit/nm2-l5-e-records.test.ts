import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm2-l5e-rec-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return { dir };
});

vi.mock('child_process', async (importOriginal) => (await import('./nm2-docker')).childProcessMock(await importOriginal()));
vi.mock('../../src/webui/server', () => ({ broadcastToClients: () => {} }));
vi.mock('../../src/config/appCapabilities', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/config/appCapabilities')>()),
  findAppCapabilities: () => ({ companionDb: { env: { url: 'DATABASE_URL' } } }),
}));
vi.mock('../../src/env/manager', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/env/manager')>()),
  getEnvVars: () => ({ DATABASE_URL: 'postgresql://app:SEKRETPW@bot-a-postgres:5432/app' }),
  getEnvVarsWithStatus: () => ({ vars: { DATABASE_URL: 'postgresql://app:SEKRETPW@bot-a-postgres:5432/app' }, undecryptable: [], encrypted: [], corrupt: false }),
}));

import * as fs from 'fs';
import * as cm from '../../src/docker/containerManager';
import { createBotRoutes } from '../../src/webui/routes/bots';
import { PRIMARY, REPLICA, seedBot, clearRegistry, stored, registryPath } from './nm2-harness';

const raw = (): string => fs.readFileSync(registryPath(), 'utf-8');
// A compact file: any save rewrites it indented, so an unchanged text proves no save ran.
const compact = (): void => fs.writeFileSync(registryPath(), JSON.stringify(JSON.parse(raw())));

beforeEach(() => clearRegistry());
afterAll(() => fs.rmSync(h.dir, { recursive: true, force: true }));

describe('NM2 L5e: stored backup texts are scrubbed on save', () => {
  it('a test restore text alone is saved with the secret replaced', () => {
    seedBot({ fleetDb: PRIMARY, fleetBackupTests: { main: { last: { at: 1, ok: false, text: 'restore failed: password SEKRETPW rejected' } } } });
    cm.updateInstanceFleetBackupStart('a', 'main', 123);
    expect(stored().fleetBackupTests.main.last.text).toBe('restore failed: password *** rejected');
  });

  it('an alert text and DM error alone are saved with the secret replaced', () => {
    seedBot({ fleetDb: PRIMARY, fleetBackupAlerts: { 'main:dumps': { since: 1, text: 'dump failed for SEKRETPW', dmError: 'DM failed SEKRETPW' } } });
    cm.updateInstanceFleetBackupStart('a', 'main', 123);
    expect(stored().fleetBackupAlerts['main:dumps']).toMatchObject({ text: 'dump failed for ***', dmError: 'DM failed ***' });
  });
});

describe('NM2 L5e: the backup record setters', () => {
  it('a missing bot is left alone by each setter', () => {
    seedBot({ fleetDb: PRIMARY });
    compact();
    const before = raw();
    expect(() => cm.updateInstanceFleetBackupTest('zz', 'main', null)).not.toThrow();
    expect(() => cm.updateInstanceFleetBackupStart('zz', 'main', 5)).not.toThrow();
    expect(() => cm.updateInstanceFleetBackupAlert('zz', 'main:dumps', null)).not.toThrow();
    expect(raw()).toBe(before);
  });

  it('a clear of an absent record and a start equal to the stored one save nothing', () => {
    seedBot({ fleetDb: PRIMARY, fleetBackupStarts: { main: 9 } });
    compact();
    const before = raw();
    cm.updateInstanceFleetBackupTest('a', 'main', null);
    cm.updateInstanceFleetBackupStart('a', 'main', 9);
    cm.updateInstanceFleetBackupAlert('a', 'main:dumps', null);
    expect(raw()).toBe(before);
  });

  it('clearing the last test or alert removes the whole field', () => {
    seedBot({ fleetDb: PRIMARY });
    cm.updateInstanceFleetBackupTest('a', 'main', { last: { at: 1, ok: true, text: 'fine' } } as any);
    cm.updateInstanceFleetBackupAlert('a', 'main:dumps', { since: 1, text: 'x' } as any);
    expect(stored().fleetBackupTests.main.last.text).toBe('fine');
    expect(stored().fleetBackupAlerts['main:dumps'].text).toBe('x');
    cm.updateInstanceFleetBackupTest('a', 'main', null);
    cm.updateInstanceFleetBackupAlert('a', 'main:dumps', null);
    expect('fleetBackupTests' in stored()).toBe(false);
    expect('fleetBackupAlerts' in stored()).toBe(false);
  });
});

describe('NM2 L5e: the standby status route', () => {
  it('answers success true for a bot with a standby', async () => {
    seedBot({ fleetDbReplica: REPLICA });
    const router = createBotRoutes({ clients: new Set() } as any);
    const layer = (router as any).stack.find((l: any) => l.route?.path === '/:id/fleet-replica' && l.route.methods.get);
    const res: any = { statusCode: 200 };
    res.status = (c: number) => { res.statusCode = c; return res; };
    res.json = (b: unknown) => { res.body = b; return res; };
    await layer.route.stack[layer.route.stack.length - 1].handle({ params: { id: 'a' }, query: {}, body: {} }, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
  });
});
