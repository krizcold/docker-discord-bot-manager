import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

// A torn or unreadable store must read as a fault, never as an empty result.
const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'b04-2-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return {
    dir,
    writeFaults: new Set<string>(),
    projectIds: null as null | string[],
    pullFails: false,
    imagePresent: false,
    inspectEnv: null as null | string[],
  };
});

vi.mock('fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('fs')>();
  const nodePath = require('path') as typeof import('path');
  const eacces = (p: unknown) => Object.assign(new Error(`EACCES: permission denied, '${p}'`), { code: 'EACCES' });
  const wrapped = {
    ...real,
    writeFileSync: (p: any, ...rest: any[]) => {
      if (typeof p === 'string' && h.writeFaults.has(nodePath.resolve(p))) throw eacces(p);
      return (real.writeFileSync as any)(p, ...rest);
    },
  };
  return { ...wrapped, default: wrapped };
});

vi.mock('../../src/docker/dockerClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/docker/dockerClient')>()),
  listProjectBotIds: async () => {
    if (h.projectIds === null) throw new Error('Cannot connect to the Docker daemon');
    return h.projectIds;
  },
  imageExists: async () => h.imagePresent,
  pullImage: async () => { if (h.pullFails) throw new Error('pull access denied'); h.imagePresent = true; },
  inspectImageEnv: () => h.inspectEnv,
}));
vi.mock('../../src/webui/server', () => ({ broadcastToClients: () => {} }));

import * as fs from 'fs';
import * as path from 'path';

let dataDir = h.dir;
const fresh = async () => {
  dataDir = fs.mkdtempSync(path.join(h.dir, 't-'));
  process.env.DATA_DIR = dataDir;
  process.env.DATA_ROOT = path.join(dataDir, 'DATA');
  h.writeFaults.clear();
  h.projectIds = null;
  h.pullFails = false;
  h.imagePresent = false;
  h.inspectEnv = null;
  vi.resetModules();
};
beforeEach(fresh);
afterAll(() => { fs.rmSync(h.dir, { recursive: true, force: true }); });

const callGet = async (router: any, routePath: string, params: Record<string, string> = {}, query: Record<string, string> = {}) => {
  const layer = router.stack.find((l: any) => l.route?.path === routePath && l.route.methods.get);
  const res: any = { statusCode: 200 };
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (b: unknown) => { res.body = b; return res; };
  await layer.route.stack[layer.route.stack.length - 1].handle({ params, query, body: {} }, res);
  return { status: res.statusCode, body: res.body };
};

const writeSources = (sources: Record<string, any>) =>
  fs.writeFileSync(path.join(dataDir, 'sources.json'), JSON.stringify({ sources }));
const gitSource = (id: string, extra: Record<string, any> = {}) => ({
  id, sourceType: 'git', url: path.join(dataDir, 'no-such-repo'), branch: '', lastCommitHash: null, lastCommitMessage: null,
  lastCommitDate: null, lastChecked: null, autoUpdate: true, composeName: null, createdAt: 'x', updatedAt: 'x', ...extra,
});

describe('instances.json', () => {
  it('a torn registry is a fault: registryFault names it and GET /api/bots answers broken', async () => {
    fs.writeFileSync(path.join(dataDir, 'instances.json'), '{"instances": {"a":');
    const cm = await import('../../src/docker/containerManager');
    expect(cm.registryFault()).toMatch(/instances\.json/);
    const { createBotRoutes } = await import('../../src/webui/routes/bots');
    const r = await callRouter(createBotRoutes({ clients: new Set() } as any), 'GET', '/');
    expect(r.status).toBe(503);
    expect(r.body.success).toBe(false);
    expect(r.body.broken).toBe(true);
    expect(r.body.error).toMatch(/instances\.json/);
    expect(fs.readFileSync(path.join(dataDir, 'instances.json'), 'utf8')).toBe('{"instances": {"a":');
  });

  it('a readable or absent registry is no fault', async () => {
    const cm = await import('../../src/docker/containerManager');
    expect(cm.registryFault()).toBeNull();
  });
});

describe('the .botmanager marker', () => {
  const markerPath = (app: string) => path.join(dataDir, 'DATA', 'AppData', app, '.botmanager');

  it('reads absent, unreadable or a marker', async () => {
    const cm = await import('../../src/docker/containerManager');
    expect(cm.readBotManagerMarker('app1')).toEqual({ state: 'absent' });
    fs.mkdirSync(path.dirname(markerPath('app1')), { recursive: true });
    fs.writeFileSync(markerPath('app1'), '{"instanceId": "b');
    expect(cm.readBotManagerMarker('app1').state).toBe('unreadable');
    fs.writeFileSync(markerPath('app1'), JSON.stringify({ instanceId: 'b9' }));
    const ok = cm.readBotManagerMarker('app1');
    expect(ok.state === 'ok' && ok.marker.instanceId).toBe('b9');
  });

  it('names a ghost only from a readable marker or the containers labels, otherwise cannot tell', async () => {
    const cm = await import('../../src/docker/containerManager');
    fs.mkdirSync(path.dirname(markerPath('app1')), { recursive: true });
    fs.writeFileSync(markerPath('app1'), '{"instanceId": "b');
    h.projectIds = null;
    const unknown = await cm.composeProjectOwner('app1', 'b1');
    expect(unknown.kind).toBe('unknown');
    expect(unknown.kind === 'unknown' && unknown.reason).toMatch(/\.botmanager cannot be read.*docker did not list/);
    h.projectIds = ['b1'];
    expect((await cm.composeProjectOwner('app1', 'b1')).kind).toBe('self');
    h.projectIds = ['b2'];
    expect((await cm.composeProjectOwner('app1', 'b1')).kind).toBe('other');
    h.projectIds = [''];
    expect((await cm.composeProjectOwner('app1', 'b1')).kind).toBe('unknown');
    h.projectIds = [];
    expect((await cm.composeProjectOwner('app1', 'b1')).kind).toBe('none');
    fs.writeFileSync(markerPath('app1'), JSON.stringify({ instanceId: 'b2' }));
    h.projectIds = null;
    expect((await cm.composeProjectOwner('app1', 'b1')).kind).toBe('other');
    fs.writeFileSync(markerPath('app1'), JSON.stringify({ instanceId: 'b1' }));
    expect((await cm.composeProjectOwner('app1', 'b1')).kind).toBe('self');
  });

  it('a failed marker write fails, and the old marker stays whole', async () => {
    const cm = await import('../../src/docker/containerManager');
    const p = markerPath('app1');
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify({ instanceId: 'b1', displayName: 'old' }));
    h.writeFaults.add(path.resolve(p));
    h.writeFaults.add(path.resolve(`${p}.tmp`));
    const inst: any = { id: 'b1', displayName: 'new', sanitizedName: 'app1', createdAt: 'x' };
    expect(() => cm.writeBotManagerMarker(inst, 'app1', true)).toThrow(/\.botmanager/);
    expect(JSON.parse(fs.readFileSync(p, 'utf8')).displayName).toBe('old');
    h.writeFaults.clear();
    cm.writeBotManagerMarker(inst, 'app1', true);
    expect(JSON.parse(fs.readFileSync(p, 'utf8')).displayName).toBe('new');
  });
});

describe('sources.json and the source routes', () => {
  it('a torn sources.json: GET /api/sources answers broken, seeding refuses and the bytes stay', async () => {
    fs.writeFileSync(path.join(dataDir, 'sources.json'), '{"sources": {');
    const sm = await import('../../src/source/sourceManager');
    expect(sm.sourceRegistryFault()).toMatch(/sources\.json/);
    expect(() => sm.seedDefaultSources()).toThrow(/sources\.json/);
    const { createSourceRoutes } = await import('../../src/webui/routes/sources');
    const r = await callGet(createSourceRoutes({ clients: new Set() } as any), '/');
    expect(r.status).toBe(503);
    expect(r.body).toMatchObject({ success: false, broken: true });
    expect(r.body.error).toMatch(/sources\.json/);
    expect(fs.readFileSync(path.join(dataDir, 'sources.json'), 'utf8')).toBe('{"sources": {');
  });

  it('isCloned comes from the repo on disk, not lastChecked', async () => {
    writeSources({ s1: gitSource('s1', { lastChecked: '2026-01-01T00:00:00Z' }), s2: gitSource('s2') });
    fs.mkdirSync(path.join(dataDir, 'sources', 's2', 'repo', '.git'), { recursive: true });
    const { createSourceRoutes } = await import('../../src/webui/routes/sources');
    const r = await callGet(createSourceRoutes({ clients: new Set() } as any), '/');
    const by = Object.fromEntries(r.body.sources.map((s: any) => [s.id, s.isCloned]));
    expect(by).toEqual({ s1: false, s2: true });
  });

  it('a failed clone is recorded on the source with its reason and time', async () => {
    writeSources({ s1: gitSource('s1') });
    const sm = await import('../../src/source/sourceManager');
    await expect(sm.fetchSource('s1')).rejects.toThrow();
    const s = sm.getSource('s1')!;
    expect(s.cloneError).toBeTruthy();
    expect(typeof s.cloneFailedAt).toBe('string');
  });

  it('GET /envs over a missing repo is an error, not an empty variable list', async () => {
    writeSources({ s1: gitSource('s1', { lastChecked: '2026-01-01T00:00:00Z' }) });
    const { createSourceRoutes } = await import('../../src/webui/routes/sources');
    const r = await callGet(createSourceRoutes({ clients: new Set() } as any), '/:id/envs', { id: 's1' });
    expect(r.body.success).toBe(false);
    expect(r.body.notCloned).toBe(true);
    expect(r.body.error).toMatch(/not cloned/i);
  });

  it('an image inspect names a failed pull or inspect', async () => {
    writeSources({ i1: { ...gitSource('i1'), sourceType: 'docker-image', imageRef: 'some/image', url: '' } });
    const { createSourceRoutes } = await import('../../src/webui/routes/sources');
    const router = createSourceRoutes({ clients: new Set() } as any);
    h.pullFails = true;
    let r = await callGet(router, '/:id/envs', { id: 'i1' }, { inspect: 'true' });
    expect(r.body.imageReady).toBe(false);
    expect(r.body.pullError).toMatch(/pull access denied/);
    h.pullFails = false;
    h.inspectEnv = null;
    r = await callGet(router, '/:id/envs', { id: 'i1' }, { inspect: 'true' });
    expect(r.body.imageReady).toBe(true);
    expect(r.body.inspectError).toBeTruthy();
    h.inspectEnv = ['FOO=1'];
    r = await callGet(router, '/:id/envs', { id: 'i1' }, { inspect: 'true' });
    expect(r.body.inspectError).toBeUndefined();
    expect(r.body.vars.map((v: any) => v.key)).toContain('FOO');
  });
});

describe('the Discord validator', () => {
  it('a failed channels read is cannot_validate and is not cached', async () => {
    const calls: string[] = [];
    let channelsStatus = 500;
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string) => {
      calls.push(url);
      if (url.endsWith('/roles')) return { status: 200, json: async () => [] } as any;
      if (url.endsWith('/channels')) {
        return channelsStatus === 200
          ? { status: 200, json: async () => [{ id: '123456', name: 'general', type: 0 }] } as any
          : { status: channelsStatus, json: async () => ({}) } as any;
      }
      return { status: 404, json: async () => null } as any;
    }) as any;
    try {
      const v = await import('../../src/discord/validator');
      expect((await v.validateDiscordId('tok', 'channel', '123456', '99999')).status).toBe('cannot_validate');
      channelsStatus = 200;
      expect(await v.validateDiscordId('tok', 'channel', '123456', '99999')).toMatchObject({ status: 'ok', name: 'general' });
      expect(calls.filter(u => u.endsWith('/channels')).length).toBe(2);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

const callRouter = (router: any, method: string, url: string, body: any = {}) => new Promise<{ status: number; body: any }>((resolve, reject) => {
  const res: any = { statusCode: 200, setHeader: () => {}, getHeader: () => undefined };
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (b: unknown) => { resolve({ status: res.statusCode, body: b }); return res; };
  router.handle({ method, url, body, params: {}, query: {}, headers: {} }, res, (err: unknown) => err ? reject(err) : resolve({ status: 404, body: null }));
});
const botsUnder = () => { const d = path.join(dataDir, 'bots'); return fs.existsSync(d) ? fs.readdirSync(d) : []; };

describe('creation and id routes over an unreadable store', () => {
  it('a torn instances.json: createInstance and createDockerImageInstance refuse before writing anything', async () => {
    writeSources({ s1: gitSource('s1') });
    fs.writeFileSync(path.join(dataDir, 'instances.json'), '{"instances": {"a":');
    const cm = await import('../../src/docker/containerManager');
    await expect(cm.createInstance({ sourceId: 's1', displayName: 'B', envVars: { DISCORD_TOKEN: 'x' } } as any)).rejects.toThrow(/instances\.json cannot be read|instances\.json\) cannot be read/);
    await expect(cm.createDockerImageInstance({ displayName: 'B', imageRef: 'a/b', envVars: { DISCORD_TOKEN: 'x' } } as any)).rejects.toThrow(/instances\.json\) cannot be read/);
    expect(botsUnder()).toEqual([]);
  });

  it('a torn instances.json: POST /api/bots refuses broken and nothing appears under bots/', async () => {
    writeSources({ s1: gitSource('s1') });
    fs.writeFileSync(path.join(dataDir, 'instances.json'), '{"instances": {"a":');
    const { createBotRoutes } = await import('../../src/webui/routes/bots');
    const r = await callRouter(createBotRoutes({ clients: new Set() } as any), 'POST', '/', { sourceId: 's1', envVars: { DISCORD_TOKEN: 'x' } });
    expect(r.status).toBe(503);
    expect(r.body).toMatchObject({ success: false, broken: true });
    expect(botsUnder()).toEqual([]);
  });

  it('a torn instances.json: an id route answers broken, not Bot not found', async () => {
    fs.writeFileSync(path.join(dataDir, 'instances.json'), '{"instances": {"a":');
    const { createBotRoutes } = await import('../../src/webui/routes/bots');
    const router = createBotRoutes({ clients: new Set() } as any);
    for (const [m, u] of [['GET', '/a'], ['POST', '/a/start']]) {
      const r = await callRouter(router, m, u);
      expect(r.status).toBe(503);
      expect(r.body.broken).toBe(true);
      expect(r.body.error).toMatch(/instances\.json/);
    }
  });

  it('a torn sources.json: createInstance names the source registry, not a missing source', async () => {
    fs.writeFileSync(path.join(dataDir, 'sources.json'), '{"sources": {');
    const cm = await import('../../src/docker/containerManager');
    await expect(cm.createInstance({ sourceId: 's1' } as any)).rejects.toThrow(/sources\.json/);
    expect(botsUnder()).toEqual([]);
  });

  it('editing a source url clears the old clone failure', async () => {
    writeSources({ s1: gitSource('s1', { cloneError: 'old reason', cloneFailedAt: '2026-01-01T00:00:00Z' }) });
    const sm = await import('../../src/source/sourceManager');
    sm.updateSource('s1', { url: path.join(dataDir, 'other-repo') } as any);
    const s = sm.getSource('s1')!;
    expect(s.cloneError ?? null).toBeNull();
    expect(s.cloneFailedAt ?? null).toBeNull();
  });
});
