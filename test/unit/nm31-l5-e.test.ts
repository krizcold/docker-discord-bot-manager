import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm31-l5-e-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return { dir };
});

vi.mock('child_process', async (importOriginal) => (await import('./nm31-run')).childProcessMock(await importOriginal(), require('fs')));
vi.mock('fs', async (importOriginal) => (await import('./nm31-run')).fsMock(await importOriginal()));
vi.mock('../../src/docker/dockerClient', async (importOriginal) => {
  const { run } = await import('./nm31-run');
  return {
    ...(await importOriginal<typeof import('../../src/docker/dockerClient')>()),
    volumeState: (name: string) => run.volumes[name] ?? 'absent',
    listBotContainersAsync: async () => [],
    listComposeContainers: async () => [],
  };
});
vi.mock('../../src/instance/appHookClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/instance/appHookClient')>()),
  callAppHook: async () => ({ ok: true, body: { saved: true } }),
}));
vi.mock('../../src/webui/server', () => ({ broadcastToClients: () => {} }));

import * as fs from 'fs';
import * as path from 'path';
import YAML from 'yaml';
import * as containerManager from '../../src/docker/containerManager';
import * as maintenance from '../../src/instance/maintenance';
import { resetDocker } from './nm2-docker';
import { clearRegistry } from './nm2-harness';
import { resetRun } from './nm31-run';
import { composePathOf, CONTAINER, resetSeed, seedMain } from './nm31-seed';
import { NOW, resetBack } from './nm31-back';

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
  resetDocker();
  resetRun();
  clearRegistry();
  fs.rmSync(path.join(h.dir, 'bots'), { recursive: true, force: true });
  resetSeed();
  resetBack();
  maintenance.resetMaintenanceState();
});
afterEach(() => { vi.restoreAllMocks(); });
afterAll(() => { fs.rmSync(h.dir, { recursive: true, force: true }); });

const composeOf = (): any => YAML.parse(fs.readFileSync(composePathOf('a'), 'utf-8'));
const dbSvc = (c: any) => Object.values(c.services as Record<string, any>).find(s => s.container_name === CONTAINER);
const fleetDb = () => ({ ...containerManager.getBot('a')!.fleetDb! });

describe('nm31 l5 e: writeFleetDbService', () => {
  it('an unknown bot is refused with Bot not found', async () => {
    expect(await containerManager.writeFleetDbService('nobody', { containerName: 'x', volume: 'v', user: 'u', db: 'd' } as any)).toEqual({ success: false, error: 'Bot not found' });
  });

  it('a record with no password writes an empty POSTGRES_PASSWORD', async () => {
    await seedMain('a');
    const rec = fleetDb();
    delete (rec as any).password;
    expect(await containerManager.writeFleetDbService('a', rec)).toEqual({ success: true });
    expect(dbSvc(composeOf()).environment.POSTGRES_PASSWORD).toBe('');
  });

  it('replication publishes hostPort:5432 on the database service only', async () => {
    await seedMain('a', { replication: true });
    expect(await containerManager.writeFleetDbService('a', fleetDb())).toEqual({ success: true });
    const c = composeOf();
    expect(dbSvc(c).ports).toEqual(['15432:5432']);
    expect(c.services.app.ports).toBeUndefined();
  });

  it('no replication leaves the database service without ports', async () => {
    await seedMain('a');
    expect(await containerManager.writeFleetDbService('a', fleetDb())).toEqual({ success: true });
    const c = composeOf();
    expect('ports' in dbSvc(c)).toBe(false);
    expect('ports' in c.services.app).toBe(false);
  });

  it('a long line in the compose is written on one line', async () => {
    await seedMain('a');
    const long = Array.from({ length: 30 }, (_, i) => `word${i}`).join(' ');
    const c = composeOf();
    c.services.app.command = long;
    fs.writeFileSync(composePathOf('a'), YAML.stringify(c, { lineWidth: 0 }));
    expect(await containerManager.writeFleetDbService('a', fleetDb())).toEqual({ success: true });
    expect(fs.readFileSync(composePathOf('a'), 'utf-8')).toContain(`command: ${long}\n`);
  });

  it('equal content is not written again', async () => {
    await seedMain('a');
    expect(await containerManager.writeFleetDbService('a', fleetDb())).toEqual({ success: true });
    const writes = vi.spyOn(fs, 'writeFileSync');
    expect(await containerManager.writeFleetDbService('a', fleetDb())).toEqual({ success: true });
    const composeWrites = writes.mock.calls.filter(c => String(c[0]).startsWith(composePathOf('a')));
    expect(composeWrites).toEqual([]);
  });
});

describe('nm31 l5 e: the verifier rows', () => {
  it('a compose with no services key answers the compose has no services section', async () => {
    await seedMain('a');
    fs.writeFileSync(composePathOf('a'), 'name: x\n');
    expect(await containerManager.writeFleetDbService('a', fleetDb())).toEqual({ success: false, error: 'the compose has no services section' });
  });

  it('with no migrate or kept record a value String() cannot read returns null', async () => {
    await seedMain('a');
    expect(containerManager.getBot('a')!.migrate).toBeUndefined();
    expect(containerManager.getBot('a')!.keptOp).toBeUndefined();
    let answer: unknown = 'threw';
    try { answer = containerManager.migrateEnvRefusal('a', { vars: { DATA_BACKEND_URL: JSON.parse('{"toString":1}') } }); } catch { /* asserted below */ }
    expect(answer).toBeNull();
  });
});
