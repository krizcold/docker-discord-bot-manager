import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'b15-1r-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return {
    dir,
    events: [] as string[],
    volumes: new Map<string, 'exists' | 'absent' | 'unknown'>(),
    onRetire: null as null | (() => void),
  };
});

const PRIMARY_VOL = 'bota-pgdata';
const REPLICA_VOL = 'bota-fleet-postgres-replica-data';
const volState = (name: string): 'exists' | 'absent' | 'unknown' => h.volumes.get(name) ?? (name === PRIMARY_VOL ? 'exists' : 'absent');

vi.mock('../../src/config/appCapabilities', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/config/appCapabilities')>();
  return { ...real, findAppCapabilities: () => ({ companionDb: { env: { url: 'DATABASE_URL' }, user: 'app', database: 'app' } }) };
});
vi.mock('../../src/env/manager', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/env/manager')>();
  return {
    ...real,
    getEnvVarsWithStatus: () => ({ vars: { DATABASE_URL: 'postgres://bot-a-postgres/app' }, corrupt: false, undecryptable: [] }),
    getEnvVars: () => ({ DATABASE_URL: 'postgres://bot-a-postgres/app' }),
  };
});
vi.mock('../../src/docker/containerManager', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/docker/containerManager')>();
  return {
    ...real,
    runningNonSidecarContainers: async () => [],
    runningInstanceContainers: async () => [],
    deployedComposeExists: () => true,
    startFleetDbSidecar: async () => { h.events.push('sidecar-up'); return { success: true }; },
    retireFleetDbSidecar: async () => { h.events.push('retire'); h.onRetire?.(); return { success: true }; },
    applyFleetDbReplicaService: async () => ({ success: false, error: 'fake apply failure' }),
  };
});
vi.mock('../../src/docker/dockerClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/docker/dockerClient')>()),
  volumeState: (name: string) => volState(name),
}));
vi.mock('../../src/instance/appHookClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/instance/appHookClient')>()),
  capabilityRefusal: () => null,
}));
vi.mock('../../src/webui/server', () => ({ broadcastToClients: () => {} }));

// A fake docker: volumes answer from h.volumes (the primary's exists unless set), this database and the pasted
// primary share a system id, and every docker run exits 0. A wipe of the replica volume is recorded as 'wipe'.
vi.mock('child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('child_process')>();
  const { EventEmitter } = require('events') as typeof import('events');
  const { PassThrough } = require('stream') as typeof import('stream');
  const execFile = (_cmd: string, args: string[], optsOrCb: unknown, maybeCb?: unknown) => {
    const cb = (typeof optsOrCb === 'function' ? optsOrCb : maybeCb) as (err: Error | null, stdout: string, stderr: string) => void;
    const sql = args.join(' ');
    if (args[0] === 'volume' && args[1] === 'inspect') {
      const state = volState(args[args.length - 1]);
      if (state === 'exists') return cb(null, '2026-10-01T00:00:00Z\n', '');
      return cb(new Error('fail'), '', state === 'absent' ? 'Error: No such volume' : 'Cannot connect to the Docker daemon');
    }
    if (args[0] === 'inspect') return cb(null, 'true\n', '');
    if (sql.includes('ALTER SYSTEM SET default_transaction_read_only = on')) { h.events.push('fence'); return cb(null, '0\n', ''); }
    if (sql.includes('ALTER SYSTEM RESET')) { h.events.push('lift'); return cb(null, '', ''); }
    if (sql.includes('SHOW default_transaction_read_only')) return cb(null, 'off\n', '');
    if (sql.includes('FROM pg_database WHERE datname')) return cb(null, '1\n', '');
    if (sql.includes('pg_control_system()')) return cb(null, '7001|2\n', '');
    if (sql.includes("to_regclass('smdb_control.term')")) return cb(null, 'f|f\n', '');
    if (sql.includes('to_regclass')) return cb(null, 'f\n', '');
    return cb(null, '', '');
  };
  const execFileSync = (cmd: string, args: string[], opts: any) => {
    if (cmd === 'docker' && args[0] === 'volume' && args[1] === 'inspect') {
      const state = volState(args[args.length - 1]);
      if (state === 'exists') return '[]';
      throw new Error(state === 'absent' ? 'Error: No such volume' : 'Cannot connect to the Docker daemon');
    }
    return real.execFileSync(cmd, args, opts);
  };
  const exec = (_cmd: string, opts: any, cb?: any) => {
    const done = typeof opts === 'function' ? opts : cb;
    done(null, { stdout: '', stderr: '' });
  };
  const spawn = (_cmd: string, args: string[]) => {
    const child: any = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.stdin.resume();
    child.kill = () => true;
    const isDump = args.includes('pg_dump');
    if (isDump) h.events.push('dump');
    if (args.some(a => a.includes(`${REPLICA_VOL}:`)) && args.some(a => a.includes('rm -rf'))) h.events.push('wipe');
    const identify = args.includes('IDENTIFY_SYSTEM');
    setTimeout(() => {
      child.stdout.end(isDump ? 'dump' : args.includes('SELECT pg_is_in_recovery()') ? 'f\n' : identify ? '7001|3|0/3000000|\n' : '');
      child.stderr.end('');
      setTimeout(() => child.emit('close', 0), 5);
    }, 5);
    return child;
  };
  const mod = { ...real, execFile: (await import('./fence-fake')).withFence(execFile as any), execFileSync, exec, spawn: (await import('./dump-fake')).withDumpHolder(spawn as any) };
  return { ...mod, default: mod };
});

import * as fs from 'fs';
import * as path from 'path';
import * as containerManager from '../../src/docker/containerManager';
import { reseedStalePrimary } from '../../src/instance/fleetReplica';
import { createBotRoutes } from '../../src/webui/routes/bots';
import { certSource } from '../../src/instance/fleetJoin';
import { codeFor, fixtureCert } from './join-fake';

beforeEach(() => { certSource.fetch = fixtureCert; });

const REGISTRY = path.join(h.dir, 'instances.json');
const primary = { containerName: 'bot-a-postgres', user: 'app', db: 'app', volume: PRIMARY_VOL };
const DSN = 'postgresql://replicator:fakepass@primary.invalid:5433/app';

const writeRegistry = (over: Record<string, unknown> = {}, others: Record<string, unknown> = {}): void => {
  fs.writeFileSync(REGISTRY, JSON.stringify({ instances: {
    a: { id: 'a', displayName: 'a', sanitizedName: 'bota', status: 'stopped', sourceUrl: 'https://example.invalid/fake/app', fleetDb: primary, fleetBackup: { enabled: false, hour: 4, keep: 7 }, ...over },
    ...others,
  } }, null, 2));
};

beforeEach(async () => {
  for (let i = 0; i < 300 && containerManager.isBotBusy('a') !== null; i++) await new Promise(r => setTimeout(r, 10));
  h.events.length = 0;
  h.volumes = new Map();
  h.onRetire = null;
  writeRegistry();
  fs.mkdirSync(path.join(h.dir, 'bots', 'a'), { recursive: true });
});
afterAll(() => { fs.rmSync(h.dir, { recursive: true, force: true }); });

const bot = () => containerManager.getBot('a')!;
const settled = async () => {
  for (let i = 0; i < 300 && !bot().fleetDbReplicaSeed?.parked && containerManager.isBotBusy('a') !== null; i++) await new Promise(r => setTimeout(r, 10));
  for (let i = 0; i < 300 && !bot().fleetDbReplicaSeed?.parked; i++) await new Promise(r => setTimeout(r, 10));
  return bot();
};
const start = (opts: { dumpDone?: boolean; run?: number; confirmVolume?: string } = {}) =>
  reseedStalePrimary(bot(), codeFor(DSN), 'standby.invalid', 5440, true, opts);

const router = createBotRoutes({ clients: new Set() } as any);
const call = async (routePath: string, req: any): Promise<{ status: number; body: any }> => {
  const layer = (router as any).stack.find((l: any) => l.route?.path === routePath && l.route.methods.post);
  const out = { status: 200, body: undefined as any };
  const res = { status(code: number) { out.status = code; return res; }, json(body: any) { out.body = body; return res; } };
  await layer.route.stack[layer.route.stack.length - 1].handle({ query: {}, body: {}, ...req }, res);
  return out;
};

describe('B15-1r: the stale-primary re-seed asks before it clears an existing replica volume', () => {
  it('asks, naming the volume, and dumps, retires and clears nothing', async () => {
    writeRegistry({ fleetDbReplicaKept: { volume: REPLICA_VOL, removedAt: '2026-10-20T00:00:00.000Z', held: 'promoted' } });
    h.volumes.set(REPLICA_VOL, 'exists');
    const res = start();
    expect(res).toMatchObject({ success: false, needsConfirm: true, confirmVolume: REPLICA_VOL });
    expect(res.error).toMatch(/bota-fleet-postgres-replica-data already exists/);
    expect(res.error).toMatch(/Remove replica left it on 2026-10-20.*promoted/);
    await new Promise(r => setTimeout(r, 60));
    expect(h.events).toEqual([]);
    expect(bot().fleetDbReplicaSeed).toBeUndefined();
    expect(bot().fleetDb).toEqual(primary);
  });

  it('runs once the confirm names the volume', async () => {
    h.volumes.set(REPLICA_VOL, 'exists');
    expect(start({ confirmVolume: REPLICA_VOL })).toMatchObject({ success: true, started: true });
    await settled();
    expect(h.events).toContain('dump');
    expect(h.events).toContain('retire');
    expect(h.events).toContain('wipe');
    expect(h.events.indexOf('retire')).toBeLessThan(h.events.indexOf('wipe'));
  });

  it('a confirm naming another volume does not answer the question', () => {
    h.volumes.set(REPLICA_VOL, 'exists');
    expect(start({ confirmVolume: 'other-volume' })).toMatchObject({ success: false, needsConfirm: true, confirmVolume: REPLICA_VOL });
  });

  it('refuses with can\'t confirm when docker does not answer, and starts nothing', async () => {
    h.volumes.set(REPLICA_VOL, 'unknown');
    const res = start({ confirmVolume: REPLICA_VOL });
    expect(res.success).toBe(false);
    expect(res.needsConfirm).toBeUndefined();
    expect(res.error).toMatch(/can't confirm/);
    await new Promise(r => setTimeout(r, 60));
    expect(h.events).toEqual([]);
    expect(bot().fleetDbReplicaSeed).toBeUndefined();
  });

  it('refuses a volume another instance declares outright, confirm or not', async () => {
    writeRegistry({}, { b: { id: 'b', displayName: 'Bot B', status: 'stopped', projectVolumes: [REPLICA_VOL] } });
    h.volumes.set(REPLICA_VOL, 'exists');
    const res = start({ confirmVolume: REPLICA_VOL });
    expect(res.success).toBe(false);
    expect(res.needsConfirm).toBeUndefined();
    expect(res.error).toMatch(/Bot B/);
    await new Promise(r => setTimeout(r, 60));
    expect(h.events).toEqual([]);
  });

  it('a volume that appears after the request stops the run before the dump and the retire', async () => {
    expect(start()).toMatchObject({ success: true });
    h.volumes.set(REPLICA_VOL, 'exists');
    const parked = await settled();
    expect(parked.fleetDbReplicaSeed?.lastError).toMatch(/nothing was destroyed: The replica volume bota-fleet-postgres-replica-data already exists/);
    expect(parked.fleetDbReplicaSeed?.committed).not.toBe(true);
    expect(h.events).not.toContain('dump');
    expect(h.events).not.toContain('retire');
    expect(h.events).not.toContain('wipe');
    expect(parked.fleetDb).toEqual(primary);
  });

  it('a volume that appears after the retire stops the run before the wipe, saying the stale database was retired', async () => {
    h.onRetire = () => { h.volumes.set(REPLICA_VOL, 'exists'); };
    expect(start()).toMatchObject({ success: true });
    const parked = await settled();
    expect(h.events).toContain('retire');
    expect(h.events).not.toContain('wipe');
    expect(parked.fleetDbReplicaSeed?.lastError).toMatch(/before clearing the replica volume \(this machine's stale database was already retired\): The replica volume bota-fleet-postgres-replica-data already exists/);
    expect(parked.fleetDbReplicaSeed?.lastError).not.toMatch(/Provision again/);
  });

  it('docker not answering at the run stops it before the dump', async () => {
    expect(start()).toMatchObject({ success: true });
    h.volumes.set(REPLICA_VOL, 'unknown');
    const parked = await settled();
    expect(parked.fleetDbReplicaSeed?.lastError).toMatch(/docker did not say whether the replica volume bota-fleet-postgres-replica-data exists, so nothing was destroyed/);
    expect(h.events).not.toContain('dump');
    expect(h.events).not.toContain('retire');
  });

  it('the route passes confirmVolume from the body', async () => {
    h.volumes.set(REPLICA_VOL, 'exists');
    const body = { joinCode: codeFor(DSN), publicHost: 'standby.invalid', hostPort: 5440, confirm: true };
    const asked = await call('/:id/fleet-reseed', { params: { id: 'a' }, body });
    expect(asked.body).toMatchObject({ success: false, needsConfirm: true, confirmVolume: REPLICA_VOL });
    const ran = await call('/:id/fleet-reseed', { params: { id: 'a' }, body: { ...body, confirmVolume: REPLICA_VOL } });
    expect(ran.body).toMatchObject({ success: true, started: true });
    await settled();
    expect(h.events).toContain('wipe');
  });
});

describe('B15-1r: the page answers the re-seed question', () => {
  const vm = require('vm') as typeof import('vm');
  const pageHtml = fs.readFileSync(path.resolve(__dirname, '../../src/webui/public/index.html'), 'utf8');
  const pageFunction = (name: string): string => {
    let start = pageHtml.indexOf(`function ${name}(`);
    if (start < 0) return '';
    if (pageHtml.slice(start - 6, start) === 'async ') start -= 6;
    let i = pageHtml.indexOf('(', start);
    for (let depth = 0; ; i++) {
      if (pageHtml[i] === '(') depth++;
      else if (pageHtml[i] === ')' && --depth === 0) break;
    }
    i = pageHtml.indexOf('{', i);
    for (let depth = 0; ; i++) {
      if (pageHtml[i] === '{') depth++;
      else if (pageHtml[i] === '}' && --depth === 0) return pageHtml.slice(start, i + 1);
    }
  };
  const runPage = (names: string[], globals: Record<string, unknown>): any => {
    const ctx = vm.createContext({ ...globals });
    vm.runInContext(names.map(pageFunction).join('\n'), ctx);
    return ctx;
  };
  const page = (answer: boolean, sent: any[], asked: string[], messages: string[][]) => runPage(['botLabel', 'reseedStalePrimary', 'postProvision', 'refuseWhileChecking'], {
    bots: [{ id: 'a', displayName: 'Bot A' }], fleetBackupBotId: null, provisionChecking: new Set(), confirm: () => true,
    window: { confirm: (text: string) => { asked.push(text); return answer; } },
    document: { getElementById: () => ({ value: 'x' }) },
    refuseBadNumbers: () => false,
    api: async (_m: string, _u: string, body: any) => {
      sent.push(body);
      return body.confirmVolume === REPLICA_VOL ? { success: true, started: true } : { success: false, needsConfirm: true, confirmVolume: REPLICA_VOL, error: 'The replica volume already exists' };
    },
    hideFleetBackups: () => {}, loadBots: () => {},
    showMessage: (t: string, m: string) => messages.push([t, m]),
  });

  it('asks with the server\'s text and resends with confirmVolume', async () => {
    const sent: any[] = []; const asked: string[] = []; const messages: string[][] = [];
    await page(true, sent, asked, messages).reseedStalePrimary('a');
    expect(asked[0]).toMatch(/The replica volume already exists[\s\S]*Clear bota-fleet-postgres-replica-data and re-seed\?/);
    expect(sent).toHaveLength(2);
    expect(sent[1].confirmVolume).toBe(REPLICA_VOL);
    expect(messages[0][0]).toBe('success');
  });

  it('a declined question sends nothing more and claims nothing', async () => {
    const sent: any[] = []; const asked: string[] = []; const messages: string[][] = [];
    await page(false, sent, asked, messages).reseedStalePrimary('a');
    expect(sent).toHaveLength(1);
    expect(messages).toEqual([]);
  });
});
