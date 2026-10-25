import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'b09-2-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return { dir, dockerFails: false };
});

vi.mock('child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('child_process')>();
  const execFile = (_cmd: string, _args: any, opts: any, cb?: any) => {
    const done = typeof opts === 'function' ? opts : cb;
    if (h.dockerFails) done(Object.assign(new Error('docker: not answering'), { stderr: 'Cannot connect to the Docker daemon' }), '', '');
    else done(null, { stdout: '', stderr: '' });
  };
  const exec = (_cmd: string, opts: any, cb?: any) => (typeof opts === 'function' ? opts : cb)(null, { stdout: '', stderr: '' });
  return { ...real, exec, execFile, default: { ...real, exec, execFile } };
});
vi.mock('../../src/webui/server', () => ({ broadcastToClients: () => {} }));

import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';

let dataDir = '';
beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(h.dir, 't-'));
  process.env.DATA_DIR = dataDir;
  process.env.DATA_ROOT = path.join(dataDir, 'DATA');
  delete process.env.ENV_ENCRYPTION_KEY;
  h.dockerFails = false;
  vi.resetModules();
});
afterAll(() => fs.rmSync(h.dir, { recursive: true, force: true }));

const routeCall = async (router: any, method: string, route: string, req: any) => {
  const layer = router.stack.find((l: any) => l.route?.path === route && l.route.methods[method]);
  const out = { status: 200, body: undefined as any };
  const res = { status(code: number) { out.status = code; return res; }, json(b: any) { out.body = b; return res; } };
  await layer.route.stack[layer.route.stack.length - 1].handle({ query: {}, body: {}, params: {}, ...req }, res);
  return out;
};

const writeEnvStore = (botId: string, store: unknown) => {
  const dir = path.join(dataDir, 'bots', botId, 'env');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'storage.json'), JSON.stringify(store));
};

describe('fleet backups: a failed read is not an empty list', () => {
  it('a missing backup folder is an empty list', async () => {
    const fb = await import('../../src/instance/fleetBackup');
    expect(fb.listFleetBackups('nobot')).toEqual([]);
  });

  it('a backup folder that cannot be read throws instead of answering no backups', async () => {
    const fb = await import('../../src/instance/fleetBackup');
    const dir = path.join(dataDir, 'backups', 'b1');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'fleet-postgres'), 'not a folder');
    expect(() => fb.listFleetBackups('b1')).toThrow(/could not be read/);
  });
});

describe('the logs popup: docker giving no answer is not an empty project', () => {
  it('listProjectContainers answers null when docker does not answer', async () => {
    h.dockerFails = true;
    const dc = await import('../../src/docker/dockerClient');
    expect(await dc.listProjectContainers('app')).toBeNull();
  });

  it('an answering docker with no containers is an empty list', async () => {
    const dc = await import('../../src/docker/dockerClient');
    expect(await dc.listProjectContainers('app')).toEqual([]);
  });
});

describe('env editor: an undecryptable value is not a missing one', () => {
  it('hasRequiredEnvVars names an undecryptable token apart from missing', async () => {
    writeEnvStore('b1', { vars: {}, encrypted: { DISCORD_TOKEN: 'ffff:eeee' } });
    const env = await import('../../src/env/manager');
    const v = env.hasRequiredEnvVars('b1', 'DISCORD_TOKEN');
    expect(v.valid).toBe(false);
    expect(v.missing).toEqual([]);
    expect(v.undecryptable).toEqual(['DISCORD_TOKEN']);
  });

  it('buildBotEnvList marks the undecryptable row', async () => {
    writeEnvStore('b1', { vars: { PLAIN: 'x' }, encrypted: { DISCORD_TOKEN: 'ffff:eeee' } });
    const { buildBotEnvList } = await import('../../src/env/envList');
    const rows = buildBotEnvList(null, 'b1', 'DISCORD_TOKEN');
    expect(rows.find(r => r.key === 'DISCORD_TOKEN')?.undecryptable).toBe(true);
    expect(rows.find(r => r.key === 'PLAIN')?.undecryptable).toBeUndefined();
  });
});

describe('vault readers report a broken vault.json', () => {
  it('GET /vault/all-values answers vaultBroken on a torn vault.json', async () => {
    fs.writeFileSync(path.join(dataDir, 'vault.json'), '{torn');
    const { createVaultRoutes } = await import('../../src/webui/routes/vault');
    const res = await routeCall(createVaultRoutes(), 'get', '/all-values', {});
    expect(res.body.vaultBroken).toBe(true);
  });

  it('GET /recover-envs answers vaultBroken on a torn vault.json', async () => {
    fs.writeFileSync(path.join(dataDir, 'vault.json'), '{torn');
    const { createValidationRoutes } = await import('../../src/webui/routes/bots');
    const res = await routeCall(createValidationRoutes(), 'get', '/recover-envs', { query: { name: 'old' } });
    expect(res.body.vaultBroken).toBe(true);
  });

  it('a healthy vault answers vaultBroken false', async () => {
    const { createVaultRoutes } = await import('../../src/webui/routes/vault');
    const res = await routeCall(createVaultRoutes(), 'get', '/all-values', {});
    expect(res.body.vaultBroken).toBe(false);
  });
});

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

const loaderCtx = (extra: any) => {
  const ctx: any = vm.createContext({
    showMessage: () => {}, renderBots: () => {}, renderSourceSidebar: () => {}, renderVault: () => {},
    busyBots: new Set(), sortSources: (s: any) => s, setTimeout: () => 0, clearTimeout: () => {},
    botsRetryTimer: null, sourcesRetryTimer: null, vaultRetryTimer: null, ...extra,
  });
  return ctx;
};

describe('UI loaders keep the last good list on a failed read', () => {
  it('loadBots keeps the bots and records the error', async () => {
    const ctx = loaderCtx({ bots: [{ id: 'b1', status: 'running' }], sources: [], botsLoadError: null,
      api: async () => ({ success: false, error: 'instances.json cannot be read' }) });
    vm.runInContext(pageFunction('loadBots'), ctx);
    await ctx.loadBots();
    expect(ctx.bots.map((b: any) => b.id)).toEqual(['b1']);
    expect(ctx.botsLoadError).toMatch(/instances\.json/);
  });

  it('loadSources keeps the sources when the manager cannot be reached', async () => {
    const ctx = loaderCtx({ sources: [{ id: 's1' }], sourcesLoadError: null, api: async () => { throw new Error('offline'); } });
    vm.runInContext(pageFunction('loadSources'), ctx);
    await ctx.loadSources();
    expect(ctx.sources.map((s: any) => s.id)).toEqual(['s1']);
    expect(ctx.sourcesLoadError).toBeTruthy();
  });

  it('loadVault keeps the groups and records the error', async () => {
    const ctx = loaderCtx({ vaultGroups: [{ id: 'g1', entries: [] }], vaultHealth: {}, vaultLoadError: null,
      api: async () => ({ success: false, error: 'boom' }) });
    vm.runInContext(pageFunction('loadVault'), ctx);
    await ctx.loadVault();
    expect(ctx.vaultGroups.map((g: any) => g.id)).toEqual(['g1']);
    expect(ctx.vaultLoadError).toMatch(/boom/);
  });
});

describe('B09-2 review: an unreadable store is not a missing value', () => {
  it('hasRequiredEnvVars on a torn storage.json reports the broken store and nothing missing', async () => {
    const dir = path.join(dataDir, 'bots', 'b1', 'env');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'storage.json'), '{"vars": {"DISC');
    const env = await import('../../src/env/manager');
    const v = env.hasRequiredEnvVars('b1', 'DISCORD_TOKEN');
    expect(v.valid).toBe(false);
    expect(v.missing).toEqual([]);
    expect(v.storeBroken).toBe(true);
  });

  it('fleetBackupScopeState is null when the env store cannot be read', async () => {
    const dir = path.join(dataDir, 'bots', 'b1', 'env');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'storage.json'), '{"vars": {"DISC');
    const fb = await import('../../src/instance/fleetBackup');
    const inst: any = { id: 'b1', sourceUrl: '', fleetDb: { containerName: 'pg' } };
    expect(fb.fleetBackupScopeState(inst)).toBeNull();
  });

  const popupHtml = async (scoped: boolean | null) => {
    const content: any = { innerHTML: '' };
    const ctx = loaderCtx({
      bots: [{ id: 'b1', displayName: 'B1', fleetDb: { containerName: 'pg' }, fleetBackup: { enabled: true, hour: 4, keep: 7, scoped } }],
      fleetBackupBotId: null, fleetBackupStoredKeep: null,
      document: { getElementById: (id: string) => id === 'fleet-backup-content' ? content : { classList: { remove: () => {} } } },
      escapeHtml: (s: string) => String(s), formatBackupSize: () => '', jsArg: (s: string) => JSON.stringify(s),
      renderSeedBanner: () => {}, renderFleetReplication: () => {}, renderRecoveryChannel: () => {},
      api: async () => ({ success: true, backups: [] }),
    });
    for (const fn of ['showFleetBackups', 'fleetBackupListHtml', 'fleetBackupErrorHtml', 'swappedAwayHtml']) vm.runInContext(pageFunction(fn), ctx);
    await ctx.showFleetBackups('b1');
    return content.innerHTML as string;
  };

  it('the backups popup says paused when the URL could not be read', async () => {
    const html = await popupHtml(null);
    expect(html).toContain('Scheduled dumps are paused: the stored database URL could not be read');
    expect(html).not.toContain('does not point at');
  });

  it('the backups popup says skipped when the URL is out of scope', async () => {
    const html = await popupHtml(false);
    expect(html).toContain('does not point at the database this manager provisioned');
    expect(html).not.toContain('could not be read');
  });
});
