import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'b15-3-cm-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return {
    dir,
    ps: '' as string | Error,
    onPs: null as null | (() => void),
    mode: 'docker' as 'docker' | 'casaos',
    vaultGroups: [] as any[],
  };
});

const fail = (stderr: string): Error => Object.assign(new Error(stderr), { stderr });
const answer = (args: string[]): string => {
  if (args[0] === 'ps') {
    if (h.onPs) { const run = h.onPs; h.onPs = null; run(); }
    if (h.ps instanceof Error) throw h.ps;
    return h.ps;
  }
  if (args.join(' ').startsWith('image inspect')) throw fail('Error: No such image: x');
  if (args[0] === 'volume' && args[1] === 'ls') return '';
  if (args[0] === 'volume') throw fail('Error: No such volume');
  return '';
};

vi.mock('child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('child_process')>();
  const execFileSync = (_f: string, args: string[]) => answer(args);
  const execFile = (_f: string, args: string[], opts: any, cb?: any) => {
    const done = typeof opts === 'function' ? opts : cb;
    try { done(null, { stdout: answer(args), stderr: '' }); } catch (e) { done(e); }
  };
  const execSync = () => '';
  const exec = (cmd: string, opts: any, cb?: any) => {
    const done = typeof opts === 'function' ? opts : cb;
    if (cmd.startsWith('docker inspect')) done(new Error('Error: No such object'));
    else if (cmd.startsWith('docker rm')) done(new Error('Error: No such container'));
    else done(null, { stdout: '', stderr: '' });
  };
  const mod = { ...real, exec, execFile, execFileSync, execSync };
  return { ...mod, default: mod };
});
vi.mock('../../src/casaos/detector', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/casaos/detector')>()),
  getDeploymentMode: async () => h.mode,
}));
vi.mock('../../src/webui/routes/vault', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/webui/routes/vault')>()),
  readVault: () => ({ state: 'ok', config: { entries: [], deletedBots: h.vaultGroups } }),
}));
vi.mock('../../src/webui/server', () => ({ broadcastToClients: () => {} }));

import * as fs from 'fs';
import * as path from 'path';
import * as containerManager from '../../src/docker/containerManager';
import { createBotRoutes, createValidationRoutes } from '../../src/webui/routes/bots';

const cm = containerManager as any;
const dataRoot = process.env.DATA_ROOT as string;
const registryPath = path.join(h.dir, 'instances.json');
const record = (id: string, name: string, over: Record<string, unknown> = {}): any => ({
  id, sanitizedName: name.toLowerCase().replace(/[^a-z0-9]/g, ''), displayName: name, titleName: name, status: 'stopped',
  sourceType: 'git', sourceUrl: 'https://example.com/a.git', envVars: {},
  createdAt: '2026-10-24T00:00:00.000Z', updatedAt: '2026-10-24T00:00:00.000Z', ...over,
});
const writeRegistry = (...instances: any[]): void => {
  fs.writeFileSync(registryPath, JSON.stringify({ instances: Object.fromEntries(instances.map((i) => [i.id, i])) }));
};
const deploy = (id: string, compose: string): void => {
  fs.mkdirSync(path.join(h.dir, 'bots', id), { recursive: true });
  fs.writeFileSync(path.join(h.dir, 'bots', id, 'docker-compose.yml'), compose);
};
const route = (router: any, routePath: string, method: string) => {
  const layer = router.stack.find((l: any) => l.route?.path === routePath && l.route.methods[method]);
  return async (req: any): Promise<{ status: number; body: any }> => {
    const out = { status: 200, body: null as any };
    const res: any = { status(c: number) { out.status = c; return res; }, json(b: any) { out.body = b; return res; } };
    await layer.route.stack[layer.route.stack.length - 1].handle(req, res);
    return out;
  };
};

beforeEach(() => {
  h.ps = '';
  h.onPs = null;
  h.mode = 'docker';
  h.vaultGroups = [];
  delete process.env.HOST_DATA_DIR;
  for (const p of ['bots', 'DATA', 'env']) fs.rmSync(path.join(h.dir, p), { recursive: true, force: true });
  fs.mkdirSync(path.join(dataRoot, 'AppData'), { recursive: true });
  writeRegistry();
});

afterAll(() => {
  fs.rmSync(h.dir, { recursive: true, force: true });
});

describe('R2-20: a rename that changes the compose name of a deployed bot is refused', () => {
  it('refuses, naming what is deployed under the old name, and leaves the record as it was', async () => {
    writeRegistry(record('b1', 'Cool Bot'));
    deploy('b1', 'services: {}\n');
    await expect(containerManager.updateBot('b1', { displayName: 'Other Bot' } as any)).rejects.toThrow(/compose name from coolbot to otherbot.*deployment or data/);
    const saved = JSON.parse(fs.readFileSync(registryPath, 'utf-8')).instances.b1;
    expect(saved.sanitizedName).toBe('coolbot');
    expect(saved.displayName).toBe('Cool Bot');
  });

  it('a display change that keeps the compose name still applies', async () => {
    writeRegistry(record('b1', 'Cool Bot'));
    deploy('b1', 'services: {}\n');
    const out = await containerManager.updateBot('b1', { displayName: 'Cool-Bot' } as any);
    expect(out?.displayName).toBe('Cool-Bot');
    expect(out?.sanitizedName).toBe('coolbot');
  });
});

describe('R9-19: a new bot never takes the name of a docker project it does not own', () => {
  it('the install moves to a free name when docker shows a foreign project', async () => {
    h.ps = 'coolbot\t\tcoolbot-db-1\n';
    const inst = await containerManager.createDockerImageInstance({ displayName: 'Cool Bot', imageRef: 'repo/img:1' } as any);
    expect(inst.sanitizedName).toBe('coolbot2');
  });

  it('a container of a registered bot does not block its project name', async () => {
    writeRegistry(record('b9', 'Elsewhere'));
    h.ps = 'coolbot\tb9\tcoolbot-app\n';
    const inst = await containerManager.createDockerImageInstance({ displayName: 'Cool Bot', imageRef: 'repo/img:1' } as any);
    expect(inst.sanitizedName).toBe('coolbot');
  });

  it('an unanswered docker listing refuses the install and creates nothing', async () => {
    h.ps = fail('Cannot connect to the Docker daemon');
    await expect(containerManager.createDockerImageInstance({ displayName: 'Cool Bot', imageRef: 'repo/img:1' } as any))
      .rejects.toThrow(/docker did not list its compose projects/);
    expect(Object.keys(JSON.parse(fs.readFileSync(registryPath, 'utf-8')).instances)).toEqual([]);
  });
});

describe('R9-18: a build never mounts storage another instance declares', () => {
  const named = 'services:\n  db:\n    image: postgres\n    volumes: ["pgdata:/var/lib/postgresql/data"]\nvolumes:\n  pgdata:\n    name: coolbot_pgdata\n';

  it('an explicitly named volume that another deployed bot declares is a conflict', () => {
    writeRegistry(record('b1', 'Cool Bot'), record('b2', 'Second'));
    deploy('b1', named);
    const out: string[] = cm.sharedStorageConflicts('b2', named);
    expect(out).toEqual(['volume coolbot_pgdata is already used by Cool Bot']);
  });

  it('a bind into another bot\'s data folder is a conflict', () => {
    process.env.HOST_DATA_DIR = '/srv/smdb';
    writeRegistry(record('b1', 'Cool Bot'), record('b2', 'Second'));
    deploy('b1', 'services:\n  app:\n    image: x\n    volumes: ["/srv/smdb/bots/b1/data:/data"]\n');
    const out: string[] = cm.sharedStorageConflicts('b2', 'services:\n  app:\n    image: x\n    volumes: ["/srv/smdb/bots/b1:/old"]\n');
    expect(out.join(' ')).toMatch(/folder \/srv\/smdb\/bots\/b1 is already used by Cool Bot/);
  });

  it('project-scoped volumes and system binds are not conflicts', () => {
    writeRegistry(record('b1', 'Cool Bot'), record('b2', 'Second'));
    const plain = 'services:\n  app:\n    image: x\n    volumes: ["data:/data", "/var/run/docker.sock:/var/run/docker.sock"]\nvolumes:\n  data: {}\n';
    deploy('b1', plain);
    expect(cm.sharedStorageConflicts('b2', plain)).toEqual([]);
  });

  it('another bot\'s compose that cannot be parsed is reported, not read as no conflict', () => {
    writeRegistry(record('b1', 'Cool Bot'), record('b2', 'Second'));
    deploy('b1', 'a: 1\na: 2\n');
    expect(cm.sharedStorageConflicts('b2', named).join(' ')).toMatch(/Cool Bot's compose .* cannot be parsed/);
  });
});

describe('R9-20: a kept CasaOS data folder is adopted only by the same source, and remembers whose it was', () => {
  const keep = (marker: Record<string, unknown>): void => {
    fs.mkdirSync(path.join(dataRoot, 'AppData', 'coolbot'), { recursive: true });
    fs.writeFileSync(path.join(dataRoot, 'AppData', 'coolbot', '.botmanager'), JSON.stringify({
      managedBy: 'docker-discord-bot-manager', displayName: 'Cool Bot', sanitizedName: 'coolbot', sourceType: 'git',
      createdAt: '2026-10-01T00:00:00.000Z', lastBuildAt: '2026-10-02T00:00:00.000Z', ...marker,
    }));
  };

  it('a build from another source is refused, naming the folder and the kept source', () => {
    keep({ instanceId: 'old', sourceUrl: 'https://example.com/other.git' });
    const out = cm.keptFolderRefusal(record('b1', 'Cool Bot'), 'coolbot');
    expect(out).toMatch(/AppData.coolbot holds data kept from https:\/\/example\.com\/other\.git/);
  });

  it('the same source adopts it, and the marker keeps the earlier instance in its lineage', () => {
    keep({ instanceId: 'old', sourceUrl: 'https://example.com/a.git' });
    expect(cm.keptFolderRefusal(record('b1', 'Cool Bot'), 'coolbot')).toBeNull();
    containerManager.writeBotManagerMarker(record('b1', 'Cool Bot'), 'coolbot', true);
    const marker = JSON.parse(fs.readFileSync(path.join(dataRoot, 'AppData', 'coolbot', '.botmanager'), 'utf-8'));
    expect(marker.instanceId).toBe('b1');
    expect(marker.lineage).toEqual([expect.objectContaining({ instanceId: 'old', sourceUrl: 'https://example.com/a.git' })]);
  });
});

describe('R10-4: data that earlier builds bound under $AppID is never silently left behind', () => {
  it('a build of a compose with $AppID binds is refused while AppData/bot-<id> exists', () => {
    const compose = 'services:\n  app:\n    volumes: ["/DATA/AppData/$AppID/data:/data"]\n';
    expect(cm.appIdFolderRefusal(record('b1', 'Cool Bot'), compose)).toBeNull();
    fs.mkdirSync(path.join(dataRoot, 'AppData', 'bot-b1'), { recursive: true });
    expect(cm.appIdFolderRefusal(record('b1', 'Cool Bot'), compose)).toMatch(/bot-b1/);
    expect(cm.appIdFolderRefusal(record('b1', 'Cool Bot'), 'services: {}\n')).toBeNull();
  });
});

describe('R2-47: the name check says whether envs can really be recovered', () => {
  const validate = route(createValidationRoutes(), '/validate-name', 'get');

  it('a kept folder with no vault group and no compose answers envsAvailable false', async () => {
    fs.mkdirSync(path.join(dataRoot, 'AppData', 'coolbot'), { recursive: true });
    fs.writeFileSync(path.join(dataRoot, 'AppData', 'coolbot', '.botmanager'), JSON.stringify({ instanceId: 'old', sourceType: 'git', sourceUrl: 'https://example.com/a.git' }));
    const { body } = await validate({ query: { name: 'Cool Bot' } });
    expect(body.reuseAvailable).toBe(true);
    expect(body.envsAvailable).toBe(false);
  });

  it('a vault group for the name answers envsAvailable true', async () => {
    h.vaultGroups = [{ id: 'g', botName: 'Cool Bot', sanitizedName: 'coolbot', deletedAt: 1, entries: [{ key: 'DISCORD_TOKEN', value: 't' }] }];
    const { body } = await validate({ query: { name: 'Cool Bot' } });
    expect(body.envsAvailable).toBe(true);
  });

  it('an unanswered docker listing answers invalid with the reason', async () => {
    h.ps = fail('Cannot connect to the Docker daemon');
    const { body } = await validate({ query: { name: 'Cool Bot' } });
    expect(body.valid).toBe(false);
    expect(body.errors.join(' ')).toMatch(/docker did not list/);
  });
});

describe('R10-3: a docker-mode keep-data Remove names the folder it leaves', () => {
  it('the answer carries the kept folder', async () => {
    writeRegistry(record('b1', 'Cool Bot', { sourceType: 'docker-image', sourceUrl: null }));
    deploy('b1', 'services: {}\n');
    const del = route(createBotRoutes({ clients: new Set() } as any), '/:id', 'delete');
    const { body } = await del({ params: { id: 'b1' }, query: { keepData: 'true', keepEnv: 'false' } });
    expect(body.success).toBe(true);
    expect(body.keptDataDir).toBe(containerManager.hostBotDirFor('b1'));
  });
});

describe('review: the docker listing never splits a registry load from its save', () => {
  const saved = (): any => JSON.parse(fs.readFileSync(registryPath, 'utf-8')).instances;
  const addDuringListing = (inst: any): void => {
    h.onPs = () => {
      const reg = JSON.parse(fs.readFileSync(registryPath, 'utf-8'));
      reg.instances[inst.id] = inst;
      fs.writeFileSync(registryPath, JSON.stringify(reg));
    };
  };

  it('an install keeps a record another writer saved while docker was listing', async () => {
    addDuringListing(record('other', 'Other Bot'));
    const inst = await containerManager.createDockerImageInstance({ displayName: 'Cool Bot', imageRef: 'repo/img:1' } as any);
    expect(Object.keys(saved()).sort()).toEqual(['other', inst.id].sort());
  });

  it('two installs of one name during the listing never share a compose name', async () => {
    addDuringListing(record('other', 'Cool Bot'));
    const inst = await containerManager.createDockerImageInstance({ displayName: 'Cool Bot', imageRef: 'repo/img:1' } as any);
    expect(inst.sanitizedName).toBe('coolbot2');
  });

  it('a rename keeps a status another writer saved while docker was listing', async () => {
    writeRegistry(record('b1', 'Cool Bot'), record('b2', 'Second', { status: 'stopped' }));
    addDuringListing(record('b2', 'Second', { status: 'running', lastBuiltCommit: 'abc' }));
    const out = await containerManager.updateBot('b1', { displayName: 'Other Bot' } as any);
    expect(out?.sanitizedName).toBe('otherbot');
    expect(saved().b2.status).toBe('running');
    expect(saved().b2.lastBuiltCommit).toBe('abc');
  });
});

describe('review: a declared volume name is never renamed onto a new empty volume', () => {
  const named = 'name: coolbot\nservices:\n  db:\n    image: postgres\n    volumes: ["pgdata:/var/lib/postgresql/data"]\nvolumes:\n  pgdata:\n    name: coolbot_pgdata\n';

  it('the second instance keeps the declared name, so its build is refused as shared', async () => {
    const { substituteComposeNames } = await import('../../src/compose/nameSubstitution');
    writeRegistry(record('b1', 'Cool Bot'), record('b2', 'Second'));
    deploy('b1', named);
    const out: any = substituteComposeNames(named, 'coolbot', 'second');
    const content = typeof out === 'string' ? out : out.content;
    expect(content).toMatch(/name: coolbot_pgdata/);
    expect(cm.sharedStorageConflicts('b2', content)).toEqual(['volume coolbot_pgdata is already used by Cool Bot']);
  });
});
