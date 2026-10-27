import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'fu-7-'));
  process.env.DATA_DIR = dir;
  return {
    dir,
    bots: [] as any[],
    fault: null as string | null,
    calls: [] as string[][],
    lstatFaults: new Set<string>(),
  };
});

vi.mock('fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('fs')>();
  const nodePath = require('path') as typeof import('path');
  const faulted = (p: unknown) => typeof p === 'string' && h.lstatFaults.has(nodePath.resolve(p));
  const lstatSync = (p: any, ...rest: any[]) => {
    if (faulted(p)) throw Object.assign(new Error(`EACCES: permission denied, lstat '${p}'`), { code: 'EACCES' });
    return (real.lstatSync as any)(p, ...rest);
  };
  const statSync = (p: any, ...rest: any[]) => {
    if (faulted(p)) throw Object.assign(new Error(`EACCES: permission denied, stat '${p}'`), { code: 'EACCES' });
    return (real.statSync as any)(p, ...rest);
  };
  const existsSync = (p: any) => (faulted(p) ? false : real.existsSync(p));
  const wrapped = { ...real, lstatSync, statSync, existsSync };
  return { ...wrapped, default: wrapped };
});

vi.mock('child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('child_process')>();
  const { EventEmitter } = await import('events');
  const { PassThrough } = await import('stream');
  const execFile = (cmd: string, args: string[], opts: any, cb?: any) => {
    const done = typeof opts === 'function' ? opts : cb;
    h.calls.push([cmd, ...args]);
    setImmediate(() => done(Object.assign(new Error('blocked in test'), { code: 1 }), '', 'blocked in test'));
    return { stdin: null };
  };
  const execFileSync = (cmd: string, args: string[]) => {
    h.calls.push([cmd, ...args]);
    throw Object.assign(new Error('blocked in test'), { stderr: 'blocked in test' });
  };
  const spawn = (cmd: string, args: string[]) => {
    h.calls.push([cmd, ...args]);
    const child: any = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.kill = () => {};
    setTimeout(() => { child.stdout.end(''); child.stderr.end('blocked in test'); child.emit('close', 1); }, 1);
    return child;
  };
  return { ...real, execFile, execFileSync, spawn, default: { ...real, execFile, execFileSync, spawn } };
});

vi.mock('../../src/webui/server', () => ({ broadcastToClients: () => {} }));
vi.mock('../../src/docker/containerManager', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/docker/containerManager')>()),
  getAllBots: () => h.bots,
  getBot: (id: string) => (h.fault ? null : h.bots.find(b => b.id === id) ?? null),
  registryFault: () => h.fault,
  deployedComposeExists: () => true,
  isBotBusy: () => null,
  isShuttingDown: () => false,
  sharedVolumeReason: () => null,
}));
vi.mock('../../src/instance/fleetReplication', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/instance/fleetReplication')>()),
  generateCertPair: async (dir: string) => {
    const fs = await import('fs');
    const path = await import('path');
    fs.writeFileSync(path.join(dir, 'server.key'), 'k');
    fs.writeFileSync(path.join(dir, 'server.crt'), 'c');
    return { ok: true };
  },
}));
vi.mock('../../src/casaos/detector', () => ({ getDeploymentMode: async () => 'docker' }));

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { validateName, makeUniqueName, checkFolderReuse } from '../../src/naming';
import { provisionFleetReplica, reseedStalePrimary } from '../../src/instance/fleetReplica';

const FAULT = 'The instance registry (instances.json) cannot be read, so the bot list is unknown and every change is refused. Repair or replace instances.json (no copy).';
const FLEET_URL = 'https://example.invalid/fake/super-modular-discord-bot';
const PEM = '-----BEGIN CERTIFICATE-----\nZmFrZQ==\n-----END CERTIFICATE-----';
const DSN = 'postgresql://replicator:fakepass@primary.invalid:5433/smdb';
const FLEET_DB = { containerName: 'bot1-fleet-postgres', user: 'smdb', db: 'smdb', volume: 'bot1-fleet-postgres-data' };

const worker = (over: Record<string, unknown> = {}): any => ({
  id: 'b1', sanitizedName: 'bot1', displayName: 'Bot 1', titleName: 'Bot 1', status: 'stopped',
  sourceType: 'git', sourceUrl: FLEET_URL, envVars: {}, containerIds: [],
  createdAt: '2026-10-24T00:00:00.000Z', updatedAt: '2026-10-24T00:00:00.000Z', ...over,
});
const other = (over: Record<string, unknown> = {}): any => worker({ id: 'b2', sanitizedName: 'bot2', displayName: 'Bot 2', titleName: 'Bot 2', ...over });

afterAll(() => { fs.rmSync(h.dir, { recursive: true, force: true }); });

describe('B04-2n: the folder-reuse check reads the .botmanager marker strictly', () => {
  let root: string;
  const prev = process.env.DATA_ROOT;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'fu-7-data-'));
    process.env.DATA_ROOT = root;
    h.lstatFaults.clear();
  });
  afterEach(() => {
    h.lstatFaults.clear();
    if (prev === undefined) delete process.env.DATA_ROOT; else process.env.DATA_ROOT = prev;
    fs.rmSync(root, { recursive: true, force: true });
  });
  const folder = (name: string) => path.join(root, 'AppData', name);
  const keepRaw = (name: string, text: string): void => {
    fs.mkdirSync(folder(name), { recursive: true });
    fs.writeFileSync(path.join(folder(name), '.botmanager'), text);
  };
  const GIT = { sourceUrl: 'https://example.com/a.git', sourceType: 'git' as const };

  it('a torn marker blocks the name when no source is given (the rename check), naming the folder and the reason', () => {
    keepRaw('coolbot', '{torn');
    const out = validateName('Cool Bot', []);
    expect(out.valid).toBe(false);
    expect(out.errors.join(' ')).toMatch(/AppData\/coolbot\/: \.botmanager cannot be parsed \(.+\), so whose data the folder holds is unknown/);
  });

  it('a marker that parses but names no instance blocks reuse even when its source matches', () => {
    keepRaw('coolbot', JSON.stringify({ sourceUrl: GIT.sourceUrl, sourceType: 'git' }));
    const out = validateName('Cool Bot', [], undefined, { source: GIT });
    expect(out.valid).toBe(false);
    expect(out.errors.join(' ')).toMatch(/AppData\/coolbot\/: \.botmanager names no instance, so whose data the folder holds is unknown/);
    const reuse = checkFolderReuse('coolbot', [], GIT);
    expect(reuse.markerUnreadable).toBe(true);
    expect(reuse.sourceMatches).toBeNull();
  });

  it('a marker that is a JSON array blocks the name without a source', () => {
    keepRaw('coolbot', '[]');
    expect(validateName('Cool Bot', []).valid).toBe(false);
  });

  it('a marker path that is a folder blocks the name', () => {
    fs.mkdirSync(path.join(folder('coolbot'), '.botmanager'), { recursive: true });
    const out = validateName('Cool Bot', []);
    expect(out.valid).toBe(false);
    expect(out.errors.join(' ')).toMatch(/AppData\/coolbot\/: \.botmanager is not a regular file, so whose data the folder holds is unknown/);
  });

  it('a marker whose check fails with a permission error blocks the name', () => {
    keepRaw('coolbot', JSON.stringify({ instanceId: 'old', ...GIT }));
    h.lstatFaults.add(path.resolve(path.join(folder('coolbot'), '.botmanager')));
    const out = validateName('Cool Bot', []);
    expect(out.valid).toBe(false);
    expect(out.errors.join(' ')).toMatch(/AppData\/coolbot\/: \.botmanager cannot be checked \(EACCES\), so whose data the folder holds is unknown/);
  });

  it('a data folder whose existence cannot be checked blocks the name instead of reading as absent', () => {
    fs.mkdirSync(folder('coolbot'), { recursive: true });
    h.lstatFaults.add(path.resolve(folder('coolbot')));
    const out = validateName('Cool Bot', [], undefined, { source: GIT });
    expect(out.valid).toBe(false);
    expect(out.errors.join(' ')).toMatch(/AppData\/coolbot\/ cannot be checked \(.*EACCES.*\)/);
    expect(makeUniqueName('Cool Bot', [], undefined, { source: GIT })).toBe('Cool Bot 2');
  });

  it('the refusal is given once, not again as an unmanaged folder', () => {
    keepRaw('coolbot', '{torn');
    const out = validateName('Cool Bot', [], undefined, { source: GIT });
    expect(out.errors).toHaveLength(1);
  });

  it('a readable marker behaves as before: reusable without a source, and with a matching source', () => {
    keepRaw('coolbot', JSON.stringify({ instanceId: 'old', ...GIT }));
    expect(validateName('Cool Bot', []).valid).toBe(true);
    expect(validateName('Cool Bot', [], undefined, { source: GIT }).valid).toBe(true);
    const reuse = checkFolderReuse('coolbot', [], GIT);
    expect(reuse).toMatchObject({ reuseAvailable: true, markerUnreadable: false, sourceMatches: true });
  });

  it('a folder with no marker is still refused as unmanaged, and an absent folder is free', () => {
    fs.mkdirSync(folder('coolbot'), { recursive: true });
    expect(validateName('Cool Bot', []).errors.join(' ')).toMatch(/exists and is not managed by Bot Manager/);
    expect(validateName('Other Bot', []).valid).toBe(true);
  });

  it('a tracked folder stays the owner\'s even with a torn marker', () => {
    keepRaw('coolbot', '{torn');
    const mine = { id: 'x', sanitizedName: 'coolbot', displayName: 'Cool Bot', titleName: 'Cool Bot' } as any;
    expect(validateName('Cool Bot', [mine], 'x').valid).toBe(true);
  });
});

describe('B04-2n: the host-port collision checks refuse while the registry cannot be read', () => {
  beforeEach(() => {
    h.bots = [];
    h.fault = null;
    h.calls = [];
  });

  it('provision refuses with a can\'t-confirm answer and calls no docker', () => {
    h.bots = [worker()];
    h.fault = FAULT;
    const res = provisionFleetReplica(h.bots[0], DSN, PEM, 'standby.invalid', 5440);
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/Host port 5440 cannot be confirmed free/);
    expect(res.error).toContain('instances.json');
    expect(res.needsConfirm).toBeUndefined();
    expect(h.calls).toEqual([]);
  });

  it('provision still names the bot that uses the port when the registry reads', () => {
    h.bots = [worker(), other({ fleetDb: { ...FLEET_DB, replication: { hostPort: 5440, publicHost: 'x.invalid' } } })];
    const res = provisionFleetReplica(h.bots[0], DSN, PEM, 'standby.invalid', 5440);
    expect(res.error).toMatch(/Host port 5440 is already used by "Bot 2"/);
  });

  it('the stale-primary re-seed refuses with a can\'t-confirm answer and calls no docker', () => {
    h.bots = [worker({ fleetDb: FLEET_DB })];
    h.fault = FAULT;
    const res = reseedStalePrimary(h.bots[0], DSN, PEM, 'standby.invalid', 5440);
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/Host port 5440 cannot be confirmed free/);
    expect(res.error).toContain('instances.json');
    expect(h.calls).toEqual([]);
  });
});
