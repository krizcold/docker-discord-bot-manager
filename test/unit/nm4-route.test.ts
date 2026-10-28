import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm4-route-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return { dir, result: null as any };
});

vi.mock('../../src/webui/server', () => ({ broadcastToClients: () => {} }));
vi.mock('../../src/instance/fleetBackup', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/instance/fleetBackup')>()),
  restoreFleetBackup: async () => h.result,
}));

import * as fs from 'fs';
import * as path from 'path';
import { createBotRoutes } from '../../src/webui/routes/bots';

const N_NOTE = 'The bot stays in its state until you choose Running in its State window. Then the bot loads the restored data: a process of it that ran before the restore, on this machine or another, restarts itself first. The State window says whether the bot here confirmed its restart.';
const STEPS = { stopped: ['w'], preRestoreDump: 'pre.dump', restored: true, claimFloor: 7, guildsRaised: ['g1'], claimRaisedTo: 8, botState: 'maintenance', restarted: ['w'] };

const router = createBotRoutes({ clients: new Set() } as any);
const post = async (id: string, body: unknown): Promise<{ status: number; body: any }> => {
  const layer = (router as any).stack.find((l: any) => l.route?.path === '/:id/fleet-backups/restore' && l.route.methods.post);
  const res: any = { statusCode: 200 };
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (b: unknown) => { res.body = b; return res; };
  await layer.route.stack[layer.route.stack.length - 1].handle({ params: { id }, query: {}, body }, res);
  return { status: res.statusCode, body: res.body };
};

afterAll(() => fs.rmSync(h.dir, { recursive: true, force: true }));
beforeEach(() => {
  fs.writeFileSync(path.join(h.dir, 'instances.json'), JSON.stringify({ instances: {
    a: { id: 'a', displayName: 'A', sanitizedName: 'a', status: 'running', sourceUrl: 'https://example.invalid/fake/app', createdAt: '2026-10-01T00:00:00.000Z' },
  } }, null, 2));
});

describe('POST /:id/fleet-backups/restore', () => {
  it('a success carries N-NOTE and the steps', async () => {
    h.result = { success: true, steps: STEPS };
    const r = await post('a', { file: 'old.dump' });
    expect(r).toEqual({ status: 200, body: { success: true, steps: STEPS, note: N_NOTE } });
  });

  it('a refusal carries the error and the steps', async () => {
    h.result = { success: false, error: 'A restore runs only in maintenance, so it was refused, and nothing was changed: x', steps: { ...STEPS, restored: false } };
    const r = await post('a', { file: 'old.dump' });
    expect(r).toEqual({ status: 200, body: { success: false, error: h.result.error, steps: h.result.steps } });
  });
});

describe('DELETE /:id/fleet-backups/restore-error (N3)', () => {
  const NOTICE = { file: 'old.dump', text: 'Restore of old.dump failed: x', at: '2026-10-28T10:00:00.000Z' };
  const del = async (id: string, at?: string): Promise<{ status: number; body: any }> => {
    const layer = (router as any).stack.find((l: any) => l.route?.path === '/:id/fleet-backups/restore-error' && l.route.methods.delete);
    const res: any = { statusCode: 200 };
    res.status = (c: number) => { res.statusCode = c; return res; };
    res.json = (b: unknown) => { res.body = b; return res; };
    await layer.route.stack[layer.route.stack.length - 1].handle({ params: { id }, query: at === undefined ? {} : { at }, body: {} }, res);
    return { status: res.statusCode, body: res.body };
  };
  const stored = () => JSON.parse(fs.readFileSync(path.join(h.dir, 'instances.json'), 'utf-8')).instances.a.fleetRestoreError;
  const withNotice = () => {
    const reg = JSON.parse(fs.readFileSync(path.join(h.dir, 'instances.json'), 'utf-8'));
    reg.instances.a.fleetDb = { containerName: 'a-postgres', user: 'app', db: 'app', volume: 'a-pgdata' };
    reg.instances.a.fleetRestoreError = NOTICE;
    fs.writeFileSync(path.join(h.dir, 'instances.json'), JSON.stringify(reg, null, 2));
  };

  it('refuses while a restore of the bot runs', async () => {
    withNotice();
    const containerManager = await import('../../src/docker/containerManager');
    let release: () => void = () => {};
    const held = containerManager.withExternalBotOp('a', 'restore', () => new Promise<void>(r => { release = r; }));
    const r = await del('a', NOTICE.at);
    release();
    await held;
    expect(r).toEqual({ status: 409, body: { success: false, error: 'A restore of this bot is running; dismiss its notice when it ends' } });
    expect(stored()).toEqual(NOTICE);
  });

  it('keeps a newer notice than the one the page showed, and says so', async () => {
    withNotice();
    const r = await del('a', '2026-10-27T10:00:00.000Z');
    expect(r).toEqual({ status: 409, body: { success: false, error: 'A newer restore notice replaced the one shown, so it was kept; read it, then dismiss it again' } });
    expect(stored()).toEqual(NOTICE);
  });

  it('clears the notice whose time the page sent', async () => {
    withNotice();
    const r = await del('a', NOTICE.at);
    expect(r).toEqual({ status: 200, body: { success: true, dismissed: true } });
    expect(stored()).toBeUndefined();
  });

  it('the Database window status sends the notice and its time', async () => {
    withNotice();
    const fleetBackup = await import('../../src/instance/fleetBackup');
    const containerManager = await import('../../src/docker/containerManager');
    const status: any = fleetBackup.fleetBackupStatus(containerManager.getBot('a')!);
    expect([status.restoreError, status.restoreErrorAt]).toEqual([NOTICE.text, NOTICE.at]);
  });
});
