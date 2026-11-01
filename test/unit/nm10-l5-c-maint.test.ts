import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm10-l5-c-maint-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return { dir };
});

vi.mock('child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('child_process')>();
  const { EventEmitter } = await import('events');
  const execFile = (_cmd: string, _args: string[], opts: any, cb?: any) => {
    const done = typeof opts === 'function' ? opts : cb;
    setTimeout(() => done(new Error('fail'), '', 'Cannot connect to the Docker daemon'), 1);
    return new EventEmitter();
  };
  const exec = (_cmd: string, opts: any, cb?: any) => {
    const done = typeof opts === 'function' ? opts : cb;
    done(new Error('Cannot connect to the Docker daemon'));
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
import * as maintenance from '../../src/instance/maintenance';
import { SETTLED } from './migrate-fake';

const SMDB = 'https://example.invalid/fake/super-modular-discord-bot';
const REGISTRY = path.join(h.dir, 'instances.json');
const RECORD = { to: 'postgres', from: 'file', destination: null, companion: true, jobId: 'mgr-c1', jobIds: ['mgr-c1'], posted: true, started: 1, kept: 0, phase: 'following', loginOpened: false, openedAt: 'x', text: 't' };
const writeRegistry = (over: Record<string, unknown> = {}) => fs.writeFileSync(REGISTRY, JSON.stringify({
  instances: {
    b: {
      id: 'b', sanitizedName: 'b', displayName: 'B', titleName: 'B', status: 'stopped', sourceType: 'git', sourceUrl: SMDB,
      envVars: {}, createdAt: '2026-10-24T00:00:00.000Z', updatedAt: '2026-10-24T00:00:00.000Z', ...over,
    },
  },
}));
const bot = () => containerManager.getBot('b')!;
const MANAGED = (publicHost?: string): any => ({
  id: 'b', sourceUrl: SMDB,
  fleetDb: { containerName: 'b-fleet-postgres', user: 'smdb', db: 'smdb', volume: 'b-fleet-postgres-data', ...(publicHost ? { replication: { publicHost, hostPort: 15433 } } : {}) },
});

beforeEach(() => {
  maintenance.resetMaintenanceState();
  fs.rmSync(path.join(h.dir, 'bots'), { recursive: true, force: true });
  fs.mkdirSync(path.join(h.dir, 'bots', 'b', 'env'), { recursive: true });
  writeRegistry();
});
afterEach(() => { vi.restoreAllMocks(); });
afterAll(() => { fs.rmSync(h.dir, { recursive: true, force: true }); });

describe('the managed test of the maintenance kind', () => {
  it('a Database URL of only spaces is the managed database', () => {
    expect(maintenance.maintenanceKind(MANAGED(), { DATA_BACKEND: 'postgres', DATA_BACKEND_URL: '   ' })).toBe('database');
  });

  it('a URL naming the bracketed replication public host is the managed database', () => {
    expect(maintenance.maintenanceKind(MANAGED('[2001:DB8::5]'), { DATA_BACKEND: 'postgres', DATA_BACKEND_URL: 'postgresql://smdb:pw@[2001:db8::5]:15433/smdb' })).toBe('database');
  });
});

describe('the state line while a migration is open', () => {
  const rec: any = { ...SETTLED };

  it('to Postgres on the managed database names the open login', () => {
    expect(maintenance.maintenanceView(rec, 'database', 'drift text', undefined, 'postgres'))
      .toBe("State: Maintenance. A data migration to Postgres is open, so the bot's database login is open for it until the migration ends.");
  });

  it('to JSON files on another kind names the destination only', () => {
    expect(maintenance.maintenanceView(rec, 'external', 'drift text', undefined, 'file'))
      .toBe('State: Maintenance. A data migration to JSON files is open.');
  });

  it('to JSON files on the managed database', () => {
    expect(maintenance.maintenanceView(rec, 'database', null, undefined, 'file'))
      .toBe("State: Maintenance. A data migration to JSON files is open, so the bot's database login is open for it until the migration ends.");
  });

  it('to Postgres on another kind', () => {
    expect(maintenance.maintenanceView(rec, 'json', null, undefined, 'postgres'))
      .toBe('State: Maintenance. A data migration to Postgres is open.');
  });
});

describe('an order run inside a lane', () => {
  it('is refused when the lane does not hold its op', async () => {
    writeRegistry({ maintenance: { ...SETTLED } });
    expect(await maintenance.runOrderInOp('b', 'running', '', 'migrate'))
      .toEqual({ refused: true, error: "the order must run under the 'migrate' operation, which is not held" });
    expect(bot().maintenance).toEqual(SETTLED);
  });
});

describe("the bot's save answer beside its order", () => {
  it('is written into the maintenance record', () => {
    writeRegistry({ maintenance: { ...SETTLED } });
    maintenance.recordHeld('b', { state: 'no', guilds: 2, files: 1 } as any);
    expect(bot().maintenance).toEqual({ ...SETTLED, held: { state: 'no', guilds: 2, files: 1 } });
  });

  it('a failed write is logged with its reason', () => {
    writeRegistry({ maintenance: { ...SETTLED } });
    vi.spyOn(containerManager, 'updateInstanceMaintenance').mockImplementation(() => { throw new Error('disk full'); });
    const errors: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { errors.push(a.map(String).join(' ')); });
    expect(() => maintenance.recordHeld('b', { state: 'yes' } as any)).not.toThrow();
    expect(errors).toContain("[Maintenance] B: the bot's save answer could not be recorded: disk full");
  });
});

describe('the state check of a bot with an open migration', () => {
  it('does not run its unconfirmed order again', async () => {
    writeRegistry({ maintenance: { ...SETTLED, settled: false }, migrate: { ...RECORD } });
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(' ')); });
    await maintenance.reconcileMaintenance();
    expect(logs.filter(l => l.includes('running it again'))).toEqual([]);
    expect(bot().maintenance).toEqual({ ...SETTLED, settled: false });
  });
});
