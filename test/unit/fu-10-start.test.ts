import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'fu-10s-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return { dir, calls: [] as Array<{ args: string[]; stdin: string }>, plainClients: '' };
});

// docker answers nothing and every command succeeds, except the database's
// non-TLS client read, which answers h.plainClients.
vi.mock('child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('child_process')>();
  const { EventEmitter } = await import('events');
  const { PassThrough } = await import('stream');
  const execFileSync = () => '';
  const execFile = (_f: string, _a: string[], opts: any, cb?: any) => {
    const done = typeof opts === 'function' ? opts : cb;
    done(null, { stdout: '', stderr: '' });
  };
  const exec = (_c: string, opts: any, cb?: any) => {
    const done = typeof opts === 'function' ? opts : cb;
    done(null, { stdout: '', stderr: '' });
  };
  const spawn = (_cmd: string, args: string[]) => {
    const call = { args: args.slice(1), stdin: '' };
    h.calls.push(call);
    const child: any = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.stdin.on('data', (d: Buffer) => { call.stdin += d.toString(); });
    child.kill = () => {};
    setTimeout(() => {
      child.stdout.end(args.join(' ').includes('pg_stat_ssl') ? `${h.plainClients}\n` : args.join(' ').includes('pg_read_file') ? '0\n' : '');
      child.stderr.end('');
      setTimeout(() => child.emit('close', 0), 1);
    }, 2);
    return child;
  };
  const mod = { ...real, exec, execFile: (await import('./fence-fake')).withFence(execFile as any), execFileSync, execSync: () => '', spawn };
  return { ...mod, default: mod };
});
vi.mock('../../src/casaos/detector', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/casaos/detector')>()),
  getDeploymentMode: async () => 'casaos',
}));
vi.mock('../../src/casaos/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/casaos/api')>()),
  deployApp: async () => ({ success: true }),
}));
vi.mock('../../src/docker/dockerClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/docker/dockerClient')>()),
  pullImage: async () => {},
  listBotContainers: async () => [{ id: 'c1', name: 'bot1', botId: 'b1', state: 'running' }],
  listContainersByBotId: async () => [],
  checkDockerConnection: async () => true,
}));
vi.mock('../../src/templates/pcsProcessing', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/templates/pcsProcessing')>()),
  fixPostDeployOwnership: async () => {},
  grantToApp: () => {},
  executeInstallCommand: async () => true,
}));
vi.mock('../../src/webui/server', () => ({ broadcastToClients: () => {} }));

import * as fs from 'fs';
import * as path from 'path';
import * as containerManager from '../../src/docker/containerManager';
import * as envManager from '../../src/env/manager';
import { pgHbaContent } from '../../src/instance/fleetReplication';

const registryPath = path.join(h.dir, 'instances.json');
const appDir = path.join(h.dir, 'DATA', 'AppData', 'casaos', 'apps', 'bot1');
const botDir = path.join(h.dir, 'bots', 'b1');
const compose = 'name: bot1\nservices:\n  bot:\n    image: example/bot:1\nx-casaos:\n  main: bot\n';
const fleetDb = { containerName: 'bot1-fleet-postgres', user: 'smdb', db: 'smdb', volume: 'bot1-fleet-postgres-data' };
const hbaWrites = () => h.calls.filter(c => c.args.join(' ').includes('pg_hba.conf'));

beforeEach(() => {
  fs.rmSync(path.join(h.dir, 'DATA'), { recursive: true, force: true });
  fs.rmSync(path.join(h.dir, 'bots'), { recursive: true, force: true });
  fs.mkdirSync(appDir, { recursive: true });
  fs.mkdirSync(path.join(botDir, 'env'), { recursive: true });
  fs.writeFileSync(path.join(appDir, 'docker-compose.yml'), compose);
  fs.writeFileSync(path.join(botDir, 'docker-compose.yml'), compose);
  fs.writeFileSync(registryPath, JSON.stringify({
    instances: {
      b1: {
        id: 'b1', sanitizedName: 'bot1', displayName: 'Bot 1', titleName: 'Bot 1', status: 'stopped',
        sourceType: 'docker-image', imageRef: 'example/bot:1',
        envVars: {}, containerIds: [], fleetDb: { ...fleetDb, keptPlain: ['10.5.0.7'] },
        createdAt: '2026-10-24T00:00:00.000Z', updatedAt: '2026-10-24T00:00:00.000Z',
      },
    },
  }));
  envManager.setEnvVars('b1', { DATA_BACKEND: 'postgres', DATA_BACKEND_URL: 'postgresql://smdb:Db-Secret-0123456789@bot1-fleet-postgres:5432/smdb?sslmode=no-verify' });
  h.calls.length = 0;
  h.plainClients = '';
});

afterAll(() => {
  fs.rmSync(h.dir, { recursive: true, force: true });
});

describe('B19-1h: the start lane narrows the lines a Disable left on the database record', () => {
  it('rewrites pg_hba and drops fleetDb.keptPlain once no kept client connects without TLS', async () => {
    const r = await containerManager.startBot('b1');
    expect(r.success).toBe(true);
    expect(hbaWrites().length).toBe(1);
    expect(hbaWrites()[0].stdin).toBe(pgHbaContent());
    expect(containerManager.getBot('b1')!.fleetDb!.keptPlain).toBeUndefined();
    expect(containerManager.getBot('b1')!.fleetDb!.replication).toBeUndefined();
  }, 20000);
});
