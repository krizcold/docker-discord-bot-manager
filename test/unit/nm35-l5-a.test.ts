import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm35-l5-a-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return { dir, exec: [] as Array<{ cmd: string; args: string[] }>, spawns: [] as string[][] };
});

vi.mock('child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('child_process')>();
  const base: any = (await import('./nm22-lane-fake')).laneChildProcess(real);
  const { EventEmitter } = await import('events');
  const { PassThrough } = await import('stream');
  const execFile = (cmd: string, args: string[], opts: any, cb?: any) => {
    h.exec.push({ cmd, args: [...args] });
    return base.execFile(cmd, args, opts, cb);
  };
  // The URL test's docker run answers at once with code 0; every other spawn goes to the lane fake.
  const spawn = (cmd: string, args: string[], ...rest: any[]) => {
    if (cmd !== 'docker' || (args[0] !== 'run' && args[0] !== 'image')) return base.spawn(cmd, args, ...rest);
    h.spawns.push([...args]);
    const child: any = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {};
    setTimeout(() => { child.stdout.end(); child.stderr.end(); setTimeout(() => child.emit('close', 0), 0); }, 1);
    return child;
  };
  return { ...base, spawn, execFile, default: { ...base.default, spawn, execFile } };
});
vi.mock('../../src/webui/server', () => ({ broadcastToClients: () => {} }));

import * as fs from 'fs';
import * as path from 'path';
import * as containerManager from '../../src/docker/containerManager';
import * as envManager from '../../src/env/manager';
import { adminReadArgs, MANAGER_SESSION_OPTIONS } from '../../src/instance/dbLogin';
import { probeDatabaseUrl } from '../../src/webui/dbProbe';
import { getFleetReplicationStatus } from '../../src/instance/fleetReplication';
import { resetLane } from './nm22-lane-fake';

const ID = '0f1e2d3c-4b5a-4968-8776-655443322110';
const fleetDb = { containerName: 'm-fleet-postgres', user: 'smdb', db: 'smdb', volume: 'm-fleet-postgres-data', password: 'Db-Secret,%x' };
const replication = { role: 'smdb_join', password: 'Join-Secret-0123456789', hostPort: 15432, publicHost: 'main.invalid', certHost: 'main.invalid', slotWalKeepMb: 4096 };

beforeEach(() => {
  resetLane();
  h.exec.length = 0;
  h.spawns.length = 0;
  fs.rmSync(path.join(h.dir, 'bots'), { recursive: true, force: true });
  fs.mkdirSync(path.join(h.dir, 'bots', ID, 'env'), { recursive: true });
  fs.writeFileSync(path.join(h.dir, 'instances.json'), JSON.stringify({ instances: { [ID]: {
    id: ID, sanitizedName: 'm', displayName: 'M', titleName: 'M', status: 'running', sourceType: 'git',
    sourceUrl: 'https://example.invalid/fake/super-modular-discord-bot', envVars: { DATA_BACKEND: 'postgres' },
    createdAt: '2026-10-24T00:00:00.000Z', updatedAt: '2026-10-24T00:00:00.000Z', fleetDb: { ...fleetDb, replication },
  } } }));
  (containerManager as any).updateInstanceFleetLogin(ID, { password: 'Own-Machine-Secret-01' });
  envManager.setEnvVars(ID, { DATA_BACKEND_URL: 'postgresql://smdb:Db-Secret%2C%25x@m-fleet-postgres:5432/smdb?sslmode=no-verify' });
});
afterEach(() => { vi.useRealTimers(); });
afterAll(() => fs.rmSync(h.dir, { recursive: true, force: true }));

describe('NM35 L5 a: whole psql argv', () => {
  it('adminReadArgs: the whole docker exec argv', () => {
    expect(adminReadArgs('b1-fleet-postgres', 'app')).toEqual(['exec', '-e', `PGOPTIONS=${MANAGER_SESSION_OPTIONS} -c default_transaction_read_only=on`,
      '-i', 'b1-fleet-postgres', 'psql', '-X', '-U', 'dbm_admin', '-d', 'app', '-tA', '-v', 'ON_ERROR_STOP=1']);
  });

  it('probeDatabaseUrl: the whole docker run argv', async () => {
    expect(await probeDatabaseUrl('postgresql://smdb:pw-secret@db.invalid:5432/smdb', null)).toEqual({ ok: true });
    const run = h.spawns.find(a => a[0] === 'run');
    expect(run).toEqual(['run', '--rm', '--pull', 'never', '-e', 'PGPASSWORD', 'postgres:16-alpine', 'psql', '-X', run![9], '-c', 'SELECT 1']);
    expect(run![9]).toMatch(/^postgresql:\/\/smdb@db\.invalid:5432\/smdb/);
  });

  it('the reachability probe: the whole docker run argv', async () => {
    await getFleetReplicationStatus(containerManager.getBot(ID)!, { probeEndpoint: true });
    const probe = h.exec.filter(c => c.args.includes('postgres:16-alpine')).pop();
    expect(probe).toEqual({ cmd: 'docker', args: ['run', '--rm', '-e', 'PGPASSWORD', 'postgres:16-alpine', 'psql', '-X',
      'postgresql://smdb@main.invalid:15432/smdb?sslmode=require&connect_timeout=8', '-Atc', 'SELECT 1'] });
  });
});
