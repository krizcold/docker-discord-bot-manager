import { afterAll, describe, expect, it, vi } from 'vitest';

// While SIGTERM's bounded wait runs, no new lane may start: process.exit would cut it at the deadline.
const tmp = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'b16-1-shutdown-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return { dir, docker: [] as string[] };
});

vi.mock('child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('child_process')>();
  const exec = (cmd: string, opts: any, cb?: any) => { tmp.docker.push(cmd); (typeof opts === 'function' ? opts : cb)(null, { stdout: '', stderr: '' }); };
  const execFile = (_c: string, args: string[], opts: any, cb?: any) => { tmp.docker.push(args.join(' ')); (typeof opts === 'function' ? opts : cb)(null, '', ''); };
  return { ...real, exec, execFile, default: { ...real, exec, execFile } };
});
vi.mock('../../src/webui/server', () => ({ broadcastToClients: () => {} }));

import * as fs from 'fs';
import * as path from 'path';
import * as containerManager from '../../src/docker/containerManager';
import * as fleetBackup from '../../src/instance/fleetBackup';
import * as recoveryRescue from '../../src/instance/recoveryRescue';
import { createBotRoutes } from '../../src/webui/routes/bots';

afterAll(() => fs.rmSync(tmp.dir, { recursive: true, force: true }));

const fleetDb = { containerName: 'bot-a-postgres', user: 'app', db: 'app', volume: 'bot-a-pgdata' };
fs.writeFileSync(path.join(tmp.dir, 'instances.json'), JSON.stringify({ instances: {
  a: { id: 'a', displayName: 'a', sanitizedName: 'bot-a', status: 'stopped', sourceUrl: 'https://example.invalid/fake/app', fleetDb,
    recoveryChannel: { mode: 'receiver', containerName: 'bot-a-recovery', token: 't', createdAt: 1 } },
} }, null, 2));

const router: any = createBotRoutes({ clients: new Set() } as any);
const gate = async (method: string, url: string): Promise<{ status: number; body: any; passed: boolean }> => {
  const layer = router.stack.find((l: any) => !l.route && l.name === 'shutdownGate');
  const res: any = { statusCode: 200 };
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (b: unknown) => { res.body = b; return res; };
  let passed = false;
  await layer.handle({ method, path: url, url, params: {}, query: {}, body: {}, headers: {} }, res, () => { passed = true; });
  return { status: res.statusCode, body: res.body, passed };
};

describe('R13-J15: a shutting-down manager admits no new lane', () => {
  it('before SIGTERM every lane is admitted', async () => {
    expect(containerManager.isShuttingDown()).toBe(false);
    expect((await gate('POST', '/a/start')).passed).toBe(true);
    expect(fleetBackup.claimFleetBackupBusy('a')).toBe(true);
    fleetBackup.releaseFleetBackupBusy('a');
  });

  it('after SIGTERM the backup slot, a restore, a rescue and the bot routes refuse, and nothing runs', async () => {
    containerManager.beginShutdown();
    tmp.docker.length = 0;
    expect(fleetBackup.claimFleetBackupBusy('a')).toBe(false);
    const restore = await fleetBackup.restoreFleetBackup('a', 'fleet-2026-10-24.dump');
    expect(restore.success).toBe(false);
    expect(restore.error).toMatch(/^The manager is shutting down/);
    const rescue = await recoveryRescue.startRescue(containerManager.getBot('a')!, true);
    expect(rescue.success).toBe(false);
    expect(rescue.error).toMatch(/^The manager is shutting down/);
    for (const url of ['/a/start', '/a/update', '/a/restart', '/a/fleet-backups/restore', '/a/recovery-rescue', '/a/request-update', '/a']) {
      const r = await gate(url === '/a' ? 'DELETE' : 'POST', url);
      expect(r.passed).toBe(false);
      expect(r.status).toBe(503);
      expect(r.body.error).toMatch(/^The manager is shutting down/);
    }
    expect((await gate('GET', '/a/fleet-backups')).passed).toBe(true);
    expect(tmp.docker).toEqual([]);
    expect(containerManager.getBot('a')?.recoveryRescue).toBeUndefined();
  });
});
