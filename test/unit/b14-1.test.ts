import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'b14-1-'));
  process.env.DATA_DIR = dir;
  return {
    dir,
    duringDump: null as null | (() => void),
    cloneGate: null as null | Promise<void>,
    duringDumpDone: false,
  };
});

// A fake docker: inspect says running, and a pg_dump writes a few bytes and
// exits 0, after h.duringDump has run.
vi.mock('child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('child_process')>();
  const { EventEmitter } = await import('events');
  const { PassThrough } = await import('stream');
  const execFile = (_cmd: string, args: string[], optsOrCb: unknown, maybeCb?: unknown) => {
    const cb = (typeof optsOrCb === 'function' ? optsOrCb : maybeCb) as (err: Error | null, stdout: string, stderr: string) => void;
    if (args[0] === 'inspect') return cb(null, 'true\n', '');
    return cb(null, '', '');
  };
  const spawn = (cmd: string, args: string[], opts?: any) => {
    if (cmd !== 'docker') return real.spawn(cmd, args, opts);
    const child: any = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {};
    setTimeout(() => {
      h.duringDump?.();
      child.stdout.end('dump');
      child.stderr.end();
      setTimeout(() => child.emit('close', 0), 5);
    }, 5);
    return child;
  };
  const heldSpawn = (await import('./dump-fake')).withDumpHolder(spawn as any);
  return { ...real, execFile, spawn: heldSpawn, default: { ...real, execFile, spawn: heldSpawn } };
});

vi.mock('simple-git', async () => {
  const nodeFs = await import('fs');
  const nodePath = await import('path');
  const make = () => {
    const client: any = {
      env: () => client,
      clone: async (_url: string, target: string) => {
        if (h.cloneGate) await h.cloneGate;
        nodeFs.mkdirSync(nodePath.join(target, '.git'), { recursive: true });
      },
      fetch: async () => {},
      status: async () => ({ behind: 0, ahead: 0, files: [] }),
      revparse: async () => 'main',
      log: async () => ({ latest: null }),
      raw: async () => '',
    };
    return client;
  };
  return { default: make, simpleGit: make };
});

vi.mock('../../src/config/appCapabilities', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/config/appCapabilities')>()),
  findAppCapabilities: () => ({ companionDb: { env: { url: 'DATABASE_URL' } } }),
}));
vi.mock('../../src/env/manager', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/env/manager')>()),
  getEnvVars: () => ({ DATABASE_URL: 'postgresql://app:pw@bot-a-postgres:5432/app' }),
  getEnvVarsWithStatus: () => ({ vars: {}, undecryptable: [], corrupt: false }),
}));
vi.mock('../../src/webui/server', () => ({ broadcastToClients: () => {} }));

import * as fs from 'fs';
import * as path from 'path';
import * as sourceManager from '../../src/source/sourceManager';
import { createBotRoutes } from '../../src/webui/routes/bots';

const REGISTRY = path.join(h.dir, 'instances.json');
const DUMPS = path.join(h.dir, 'backups', 'a', 'fleet-postgres');
const fleetDb = { containerName: 'bot-a-postgres', user: 'app', db: 'app', volume: 'bot-a-pgdata' };

function seed(fleetBackup: Record<string, unknown>): void {
  fs.writeFileSync(REGISTRY, JSON.stringify({ instances: { a: { id: 'a', displayName: 'a', sourceUrl: 'x', fleetDb, fleetBackup } } }, null, 2));
}
const stored = () => JSON.parse(fs.readFileSync(REGISTRY, 'utf-8')).instances.a.fleetBackup;

function seedDumps(count: number, mtimeOffsetMs: number): string[] {
  fs.rmSync(DUMPS, { recursive: true, force: true });
  fs.mkdirSync(DUMPS, { recursive: true });
  const names: string[] = [];
  for (let i = 0; i < count; i++) {
    const name = `2026-01-0${i + 1}T04-00-00-000Z.dump`;
    const p = path.join(DUMPS, name);
    fs.writeFileSync(p, 'old');
    const t = (Date.now() + mtimeOffsetMs - (count - i) * 86400000) / 1000;
    fs.utimesSync(p, t, t);
    names.push(name);
  }
  return names;
}
const dumpsNow = () => fs.readdirSync(DUMPS).filter(f => f.endsWith('.dump')).sort();

async function runOneTick(): Promise<void> {
  vi.resetModules();
  const fb = await import('../../src/instance/fleetBackup');
  let tick: () => void = () => {};
  const spy = vi.spyOn(globalThis, 'setInterval').mockImplementation(((fn: () => void) => { tick = fn; return 0; }) as unknown as typeof setInterval);
  fb.startFleetBackupScheduler();
  spy.mockRestore();
  fb.stopFleetBackupScheduler();
  const lines: string[] = [];
  const log = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { lines.push(a.join(' ')); });
  const err = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { lines.push(a.join(' ')); });
  try {
    tick();
    await vi.waitFor(() => expect(lines.some(l => l.includes('[FleetBackup] Dump'))).toBe(true), { timeout: 3000 });
  } finally { log.mockRestore(); err.mockRestore(); }
  expect(lines.join('\n')).toContain('[FleetBackup] Dumped');
}

beforeEach(() => {
  h.duringDump = null;
  h.cloneGate = null;
  h.duringDumpDone = false;
});
afterAll(() => { fs.rmSync(h.dir, { recursive: true, force: true }); });

describe('the scheduled trim', () => {
  const hour = () => new Date().getHours();

  it('never deletes the dump just written after a clock step back', async () => {
    seed({ enabled: true, hour: hour() });
    const old = seedDumps(3, 10 * 86400000);
    h.duringDump = () => { h.duringDumpDone = true; };
    await runOneTick();
    await vi.waitFor(() => expect(dumpsNow().some(f => !old.includes(f))).toBe(true), { timeout: 3000 });
    expect(dumpsNow().length).toBe(4);
  });

  it('keeps the previous night dump while older dumps carry future mtimes', async () => {
    seed({ enabled: true, hour: hour() });
    const old = seedDumps(3, 10 * 86400000);
    const post = '2026-02-01T04-00-00-000Z.dump';
    fs.writeFileSync(path.join(DUMPS, post), 'old');
    const t = (Date.now() - 86400000) / 1000;
    fs.utimesSync(path.join(DUMPS, post), t, t);
    h.duringDump = () => { h.duringDumpDone = true; };
    await runOneTick();
    await vi.waitFor(() => expect(dumpsNow().length).toBe(5), { timeout: 3000 });
    expect(dumpsNow()).toContain(post);
    for (const f of old) expect(dumpsNow()).toContain(f);
  });

});

describe('PUT /:id/fleet-backup-config', () => {
  const router = createBotRoutes({ clients: new Set() } as any);
  const put = async (body: unknown): Promise<{ status: number; body: any }> => {
    const layer = (router as any).stack.find((l: any) => l.route?.path === '/:id/fleet-backup-config' && l.route.methods.put);
    const res: any = { statusCode: 200 };
    res.status = (c: number) => { res.statusCode = c; return res; };
    res.json = (b: unknown) => { res.body = b; return res; };
    await layer.route.stack[layer.route.stack.length - 1].handle({ params: { id: 'a' }, query: {}, body }, res);
    return { status: res.statusCode, body: res.body };
  };

  it('refuses a stale tab\'s save and keeps the newer hour', async () => {
    seed({ enabled: true, hour: 4 });
    const first = await put({ enabled: true, hour: 10, expected: { enabled: true, hour: 4 } });
    expect(first.status).toBe(200);
    const stale = await put({ enabled: true, hour: 3, expected: { enabled: true, hour: 4 } });
    expect(stale.status).toBe(409);
    expect(stale.body.fleetBackup).toEqual({ enabled: true, hour: 10 });
    expect(stored()).toEqual({ enabled: true, hour: 10 });
  });

  it('a changed field saves alone and leaves the others as stored', async () => {
    seed({ enabled: true, hour: 6 });
    const r = await put({ enabled: false, expected: { enabled: true } });
    expect(r.status).toBe(200);
    expect(stored()).toEqual({ enabled: false, hour: 6 });
  });

  for (const bad of [{ hour: 25 }, { hour: 2.5 }]) {
    it(`refuses ${JSON.stringify(bad)} and saves nothing`, async () => {
      seed({ enabled: true, hour: 4 });
      const r = await put({ enabled: true, ...bad, expected: { enabled: true, hour: 4 } });
      expect(r.status).toBe(400);
      expect(stored()).toEqual({ enabled: true, hour: 4 });
    });
  }
});

describe('createSource', () => {
  it('keeps a source update made while the clone runs', async () => {
    const first = await sourceManager.createSource({ url: 'https://example.invalid/o/first.git', branch: 'main' });
    let open!: () => void;
    h.cloneGate = new Promise<void>(r => { open = r; });
    const second = sourceManager.createSource({ url: 'https://example.invalid/o/second.git', branch: 'main' });
    await new Promise(r => setTimeout(r, 20));
    sourceManager.updateSource(first.id, { autoUpdate: false });
    open();
    const made = await second;
    const reg = sourceManager.loadSourceRegistry();
    expect(reg.sources[first.id].autoUpdate).toBe(false);
    expect(reg.sources[made.id]).toBeTruthy();
  });
});
