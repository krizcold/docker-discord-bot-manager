import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

// A store file can exist yet fail to answer: a permission or antivirus lock,
// a disk error. The fault map makes every read-side call on a path fail the
// way node fails it (existsSync answers false, the rest throw), while writes
// and renames still succeed, which is what lets a wrong "absent" overwrite.
const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'b04-1-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return { dir, faults: new Set<string>(), writeFaults: new Set<string>(), dockerPs: 'none' as 'none' | 'casaos' | 'fail' };
});

vi.mock('fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('fs')>();
  const nodePath = require('path') as typeof import('path');
  const hit = (p: unknown) => typeof p === 'string' && h.faults.has(nodePath.resolve(p));
  const eacces = (p: unknown) => Object.assign(new Error(`EACCES: permission denied, '${p}'`), { code: 'EACCES' });
  const guard = <F extends (...a: any[]) => any>(fn: F): F => ((p: unknown, ...rest: any[]) => {
    if (hit(p)) throw eacces(p);
    return fn(p, ...rest);
  }) as F;
  const wrapped = {
    ...real,
    existsSync: (p: any) => (hit(p) ? false : real.existsSync(p)),
    lstatSync: guard(real.lstatSync),
    statSync: guard(real.statSync),
    readFileSync: guard(real.readFileSync),
    copyFileSync: guard(real.copyFileSync),
    writeFileSync: (p: any, ...rest: any[]) => {
      if (typeof p === 'string' && h.writeFaults.has(nodePath.resolve(p))) throw eacces(p);
      return (real.writeFileSync as any)(p, ...rest);
    },
    renameSync: (a: any, b: any) => {
      for (const p of [a, b]) if (typeof p === 'string' && h.writeFaults.has(nodePath.resolve(p))) throw eacces(p);
      return real.renameSync(a, b);
    },
  };
  return { ...wrapped, default: wrapped };
});

vi.mock('child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('child_process')>();
  const exec = (cmd: string, opts: any, cb?: any) => {
    const done = typeof opts === 'function' ? opts : cb;
    if (cmd.startsWith('docker ps') && h.dockerPs === 'fail') done(new Error('Cannot connect to the Docker daemon'));
    else if (cmd.startsWith('docker ps')) done(null, { stdout: h.dockerPs === 'casaos' ? 'casaos\n' : '', stderr: '' });
    else done(null, { stdout: '', stderr: '' });
  };
  return { ...real, exec, default: { ...real, exec } };
});
vi.mock('../../src/webui/server', () => ({ broadcastToClients: () => {} }));

import * as fs from 'fs';
import * as path from 'path';

const fault = (p: string) => h.faults.add(path.resolve(p));
const copiesOf = (p: string) => fs.readdirSync(path.dirname(p)).filter(n => n.startsWith(path.basename(p) + '.corrupt'));

let dataDir = h.dir;
// Each test gets its own data dir and fresh modules: the key material and
// every store path are resolved at import.
const fresh = async () => {
  dataDir = fs.mkdtempSync(path.join(h.dir, 't-'));
  process.env.DATA_DIR = dataDir;
  process.env.DATA_ROOT = path.join(dataDir, 'DATA');
  delete process.env.ENV_ENCRYPTION_KEY;
  delete process.env.DEPLOYMENT_MODE;
  h.faults.clear();
  h.writeFaults.clear();
  h.dockerPs = 'none';
  vi.resetModules();
};

beforeEach(fresh);
afterAll(() => {
  h.faults.clear();
  fs.rmSync(h.dir, { recursive: true, force: true });
});

describe('the encryption key and salt', () => {
  it('never overwrites an existing torn (empty) key file, and refuses secret writes', async () => {
    fs.writeFileSync(path.join(dataDir, 'env-encryption.key'), '');
    const env = await import('../../src/env/manager');
    expect(fs.readFileSync(path.join(dataDir, 'env-encryption.key'), 'utf8')).toBe('');
    expect(env.secretKeyProblem()).toMatch(/env-encryption\.key/);
    expect(() => env.setEnvVars('b1', { API_TOKEN: 'secret' })).toThrow(env.SecretKeyUnavailableError);
    expect(fs.existsSync(path.join(dataDir, 'bots', 'b1', 'env', 'storage.json'))).toBe(false);
  });

  it('refuses secret writes while a short (torn) key is the only key', async () => {
    fs.writeFileSync(path.join(dataDir, 'env-encryption.key'), 'abc123');
    const env = await import('../../src/env/manager');
    expect(() => env.encrypt('x')).toThrow(/env-encryption\.key exists but is empty or damaged/);
    expect(fs.readFileSync(path.join(dataDir, 'env-encryption.key'), 'utf8')).toBe('abc123');
  });

  it('refuses secret writes when the key file exists but cannot be read', async () => {
    const key = path.join(dataDir, 'env-encryption.key');
    fs.writeFileSync(key, 'a'.repeat(64));
    fault(key);
    const env = await import('../../src/env/manager');
    expect(env.secretKeyProblem()).toMatch(/EACCES/);
    expect(() => env.setEnvVars('b1', { API_TOKEN: 'secret' })).toThrow(/Secrets cannot be saved/);
    h.faults.clear();
    expect(fs.readFileSync(key, 'utf8')).toBe('a'.repeat(64));
  });

  it('refuses secret writes when a new key could not be saved', async () => {
    for (const n of ['env-encryption.salt', 'env-encryption.salt.tmp']) h.writeFaults.add(path.resolve(dataDir, n));
    const env = await import('../../src/env/manager');
    expect(() => env.setEnvVars('b1', { API_TOKEN: 'secret' })).toThrow(/Secrets cannot be saved/);
    expect(env.secretKeyProblem()).toMatch(/env-encryption\.salt could not be saved/);
  });

  it('creates both on a definite absence and keeps them across restarts', async () => {
    let env = await import('../../src/env/manager');
    expect(env.secretKeyProblem()).toBeNull();
    env.setEnvVars('b1', { API_TOKEN: 'secret' });
    const key = fs.readFileSync(path.join(dataDir, 'env-encryption.key'), 'utf8');
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(fs.readFileSync(path.join(dataDir, 'env-encryption.salt'), 'utf8')).toMatch(/^[0-9a-f]{32}$/);
    vi.resetModules();
    env = await import('../../src/env/manager');
    expect(env.getEnvVars('b1')).toEqual({ API_TOKEN: 'secret' });
  });
});

describe('the env store', () => {
  it('an unreadable storage.json is broken, not absent: writes refuse and the file stays', async () => {
    const env = await import('../../src/env/manager');
    env.setEnvVars('b1', { KEEP: 'k', API_TOKEN: 'secret' });
    const store = path.join(dataDir, 'bots', 'b1', 'env', 'storage.json');
    const before = fs.readFileSync(store, 'utf8');
    fault(store);
    expect(env.getEnvVarsWithStatus('b1').corrupt).toBe(true);
    expect(() => env.setEnvVars('b1', { OTHER: 'o' })).toThrow(/cannot be read; refusing to overwrite/);
    expect(() => env.deleteEnvVar('b1', 'KEEP')).toThrow(/refusing to overwrite/);
    h.faults.clear();
    expect(fs.readFileSync(store, 'utf8')).toBe(before);
  });

  it('keeps every incident copy: a healthy load deletes none, and a new incident adds its own', async () => {
    const env = await import('../../src/env/manager');
    const store = path.join(dataDir, 'bots', 'b1', 'env', 'storage.json');
    fs.mkdirSync(path.dirname(store), { recursive: true });
    fs.writeFileSync(store, '{torn');
    expect(env.getEnvVarsWithStatus('b1').corrupt).toBe(true);
    env.getEnvVarsWithStatus('b1');
    expect(copiesOf(store)).toHaveLength(1);
    fs.writeFileSync(store, JSON.stringify({ vars: { A: '1' }, encrypted: {} }));
    expect(env.getEnvVarsWithStatus('b1').corrupt).toBe(false);
    expect(copiesOf(store)).toHaveLength(1);
    fs.writeFileSync(store, '{torn again');
    env.getEnvVarsWithStatus('b1');
    const copies = copiesOf(store);
    expect(copies).toHaveLength(2);
    expect(copies.map(c => fs.readFileSync(path.join(path.dirname(store), c), 'utf8')).sort()).toEqual(['{torn', '{torn again']);
  });
});

describe('the config-file store', () => {
  it('an unreadable configFiles.json is broken, not absent', async () => {
    const cfg = await import('../../src/config/configFileManager');
    cfg.setConfigFiles('b1', [{ path: '/app/config.json', body: '{"t":1}' }]);
    const store = path.join(dataDir, 'bots', 'b1', 'env', 'configFiles.json');
    const before = fs.readFileSync(store, 'utf8');
    fault(store);
    expect(cfg.getConfigFilesWithStatus('b1').corrupt).toBe(true);
    expect(() => cfg.setConfigFiles('b1', [])).toThrow(/refusing to overwrite/);
    h.faults.clear();
    expect(fs.readFileSync(store, 'utf8')).toBe(before);
  });

  it('GET /:id/config reports the store health to the editor', async () => {
    fs.writeFileSync(path.join(dataDir, 'instances.json'), JSON.stringify({
      instances: { b1: { id: 'b1', sanitizedName: 'bot1', displayName: 'Bot 1', titleName: 'Bot 1', status: 'stopped', sourceType: 'docker-image', createdAt: 'x', updatedAt: 'x' } },
    }));
    const store = path.join(dataDir, 'bots', 'b1', 'env', 'configFiles.json');
    fs.mkdirSync(path.dirname(store), { recursive: true });
    fs.writeFileSync(store, '{"files": [');
    const out = await botCall('get', '/:id/config', { id: 'b1' });
    expect(out.status).toBe(200);
    expect(out.body.storeBroken).toBe(true);
    expect(out.body.corruptCopies).toHaveLength(1);
    expect(out.body).toHaveProperty('secretKeyProblem', null);
  });
});

describe('the vault', () => {
  const vaultRoutes = async () => {
    const mod = await import('../../src/webui/routes/vault');
    const router = mod.createVaultRoutes();
    const call = async (method: string, routePath: string, req: any) => {
      const layer = (router as any).stack.find((l: any) => l.route?.path === routePath && l.route.methods[method]);
      const out = { status: 200, body: undefined as any };
      const res = { status(code: number) { out.status = code; return res; }, json(body: any) { out.body = body; return res; } };
      await layer.route.stack[layer.route.stack.length - 1].handle({ query: {}, body: {}, params: {}, ...req }, res);
      return out;
    };
    return { mod, call };
  };

  it('an unreadable vault.json refuses every save and is reported broken', async () => {
    const { mod, call } = await vaultRoutes();
    expect((await call('post', '/standalone', { body: { key: 'A', value: 'one' } })).body.success).toBe(true);
    const vaultFile = path.join(dataDir, 'vault.json');
    const before = fs.readFileSync(vaultFile, 'utf8');
    fault(vaultFile);
    expect(mod.vaultFileBroken()).toBe(true);
    const res = await call('post', '/standalone', { body: { key: 'B', value: 'two' } });
    expect(res.status).toBe(500);
    expect(res.body.success).toBe(false);
    h.faults.clear();
    expect(fs.readFileSync(vaultFile, 'utf8')).toBe(before);
  });

  it('a mutator never saves from a broken load, even when the file reads again by save time', async () => {
    const { mod } = await vaultRoutes();
    const vaultFile = path.join(dataDir, 'vault.json');
    fs.writeFileSync(vaultFile, '{torn');
    const loaded = mod.loadVault();
    fs.writeFileSync(vaultFile, JSON.stringify({ v: 1, data: (await import('../../src/env/manager')).encrypt(JSON.stringify({ standalone: [{ key: 'A', value: 'v', hidden: true }], deletedBots: [] })) }));
    expect(() => mod.saveVault(loaded)).toThrow(/nothing was saved/);
    expect(mod.loadVault().standalone).toHaveLength(1);
  });

  it('lists the kept incident copies in GET /vault, and a healthy load keeps them', async () => {
    const { call } = await vaultRoutes();
    const vaultFile = path.join(dataDir, 'vault.json');
    fs.writeFileSync(vaultFile, '{torn');
    let res = await call('get', '/', {});
    expect(res.body.vaultBroken).toBe(true);
    expect(res.body.corruptCopies).toHaveLength(1);
    fs.rmSync(vaultFile);
    res = await call('get', '/', {});
    expect(res.body.vaultBroken).toBe(false);
    expect(res.body.corruptCopies).toHaveLength(1);
  });
});

describe('the instance and source registries', () => {
  it('a broken instances.json is never overwritten by a create', async () => {
    const reg = path.join(dataDir, 'instances.json');
    fs.writeFileSync(reg, JSON.stringify({ instances: { b1: { id: 'b1', displayName: 'Bot 1', sanitizedName: 'bot1' } } }));
    const before = fs.readFileSync(reg, 'utf8');
    fault(reg);
    const cm = await import('../../src/docker/containerManager');
    expect(cm.getAllBots()).toEqual([]);
    await expect(cm.createDockerImageInstance({ displayName: 'New', imageRef: 'fake/app:1' })).rejects.toThrow(/instances\.json/);
    h.faults.clear();
    expect(fs.readFileSync(reg, 'utf8')).toBe(before);
  });

  it('a refusal never names an earlier incident\'s copy as the current bytes', async () => {
    const reg = path.join(dataDir, 'instances.json');
    fs.writeFileSync(reg, '{"instances": {"b1"');
    const cm = await import('../../src/docker/containerManager');
    cm.getAllBots();
    const [old] = copiesOf(reg);
    expect(old).toBeTruthy();
    fs.writeFileSync(reg, JSON.stringify({ instances: { b1: { id: 'b1', displayName: 'Bot 1', sanitizedName: 'bot1' } } }));
    fault(reg);
    const err = await cm.createDockerImageInstance({ displayName: 'New', imageRef: 'fake/app:1' }).then(() => null, (e: Error) => e);
    expect(err?.message).toMatch(/instances\.json/);
    expect(err?.message).not.toContain(old);
    expect(err?.message).toMatch(/no copy of the current instances\.json could be kept/);
  });

  it('a torn instances.json keeps one copy per incident and never replaces it', async () => {
    const reg = path.join(dataDir, 'instances.json');
    fs.writeFileSync(reg, '{"instances": {"b1"');
    const cm = await import('../../src/docker/containerManager');
    cm.getAllBots();
    fs.writeFileSync(reg, '{"instances": {"b1": {');
    cm.getAllBots();
    cm.getAllBots();
    expect(copiesOf(reg)).toHaveLength(2);
  });

  it('boot seeding never writes default sources over an unreadable sources.json', async () => {
    const reg = path.join(dataDir, 'sources.json');
    fs.writeFileSync(reg, JSON.stringify({ sources: { s1: { id: 's1', url: 'https://example.invalid/r.git' } } }));
    const before = fs.readFileSync(reg, 'utf8');
    fault(reg);
    const sm = await import('../../src/source/sourceManager');
    expect(() => sm.seedDefaultSources()).toThrow(/sources\.json/);
    h.faults.clear();
    expect(fs.readFileSync(reg, 'utf8')).toBe(before);
  });
});

const botCall = async (method: string, route: string, params: any, query: any = {}) => {
  const { createBotRoutes } = await import('../../src/webui/routes/bots');
  const router = createBotRoutes({ clients: new Set() } as any);
  const layer = (router as any).stack.find((l: any) => l.route?.path === route && l.route.methods[method]);
  const out = { status: 200, body: undefined as any };
  const res = { status(code: number) { out.status = code; return res; }, json(b: any) { out.body = b; return res; } };
  await layer.route.stack[layer.route.stack.length - 1].handle({ params, query, body: {} }, res);
  return out;
};

describe('the deployment mode', () => {
  it('a torn config.json leaves the mode undecided: no re-detection, no overwrite', async () => {
    const cfg = path.join(dataDir, 'config.json');
    fs.writeFileSync(cfg, '{"deploymentMode": "cas');
    const det = await import('../../src/casaos/detector');
    await expect(det.getDeploymentMode()).rejects.toThrow(/config\.json could not be read/);
    expect(fs.readFileSync(cfg, 'utf8')).toBe('{"deploymentMode": "cas');
    expect(copiesOf(cfg)).toHaveLength(1);
  });

  it('an unreadable config.json is broken, not absent', async () => {
    const cfg = path.join(dataDir, 'config.json');
    fs.writeFileSync(cfg, JSON.stringify({ deploymentMode: 'casaos', autoDetected: false }));
    fault(cfg);
    const det = await import('../../src/casaos/detector');
    await expect(det.getDeploymentMode()).rejects.toThrow(/config\.json could not be read/);
    h.faults.clear();
    expect(JSON.parse(fs.readFileSync(cfg, 'utf8')).deploymentMode).toBe('casaos');
  });

  it('a detection whose docker ps fails decides nothing and persists nothing', async () => {
    h.dockerPs = 'fail';
    const det = await import('../../src/casaos/detector');
    await expect(det.getDeploymentMode()).rejects.toThrow(/could not be detected/);
    expect(fs.existsSync(path.join(dataDir, 'config.json'))).toBe(false);
    h.dockerPs = 'casaos';
    await expect(det.getDeploymentMode()).resolves.toBe('casaos');
    expect(JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8'))).toEqual({ deploymentMode: 'casaos', autoDetected: true });
  }, 20000);

  const systemCall = async (method: string, body: any) => {
    const { createSystemRoutes } = await import('../../src/webui/routes/bots');
    const router = createSystemRoutes();
    const layer = (router as any).stack.find((l: any) => l.route?.path === '/deployment' && l.route.methods[method]);
    const out = { status: 200, body: undefined as any };
    const res = { status(code: number) { out.status = code; return res; }, json(b: any) { out.body = b; return res; } };
    await layer.route.stack[layer.route.stack.length - 1].handle({ query: {}, params: {}, body }, res);
    return out;
  };

  it('PUT /deployment answers 500 when the mode could not be saved, and does not switch', async () => {
    fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({ deploymentMode: 'docker', autoDetected: false }));
    for (const n of ['config.json', 'config.json.tmp']) h.writeFaults.add(path.resolve(dataDir, n));
    const res = await systemCall('put', { mode: 'casaos' });
    expect(res.status).toBe(500);
    expect(res.body.success).toBe(false);
    const det = await import('../../src/casaos/detector');
    await expect(det.getDeploymentMode()).resolves.toBe('docker');
  });

  it('an undecided mode names the real remedy, the deployment endpoint', async () => {
    fs.writeFileSync(path.join(dataDir, 'config.json'), '{"deploymentMode": "cas');
    const det = await import('../../src/casaos/detector');
    await expect(det.getDeploymentMode()).rejects.toThrow(/PUT \/api\/system\/deployment/);
  });

  it('GET /bots still lists every bot while the mode is undecided', async () => {
    fs.writeFileSync(path.join(dataDir, 'instances.json'), JSON.stringify({
      instances: { b1: { id: 'b1', sanitizedName: 'bot1', displayName: 'Bot 1', titleName: 'Bot 1', status: 'running', sourceType: 'docker-image', createdAt: 'x', updatedAt: 'x' } },
    }));
    fs.writeFileSync(path.join(dataDir, 'config.json'), '{"deploymentMode": "cas');
    const out = await botCall('get', '/', {});
    expect(out.status).toBe(200);
    expect(out.body.bots.map((b: any) => b.id)).toEqual(['b1']);
    expect(out.body.bots[0].webOpenUrl).toBeNull();
    expect(out.body.deploymentMode).toBeNull();
    expect(out.body.deploymentModeError).toMatch(/config\.json/);
  });

  it('PUT /deployment refuses a mode DEPLOYMENT_MODE overrides', async () => {
    process.env.DEPLOYMENT_MODE = 'docker';
    const res = await systemCall('put', { mode: 'casaos' });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/DEPLOYMENT_MODE/);
    expect(fs.existsSync(path.join(dataDir, 'config.json'))).toBe(false);
  });
});

describe('Remove with the env kept', () => {
  it('refuses while the env store cannot be read', async () => {
    fs.writeFileSync(path.join(dataDir, 'instances.json'), JSON.stringify({
      instances: { b1: { id: 'b1', sanitizedName: 'bot1', displayName: 'Bot 1', titleName: 'Bot 1', status: 'stopped', sourceType: 'docker-image', createdAt: 'x', updatedAt: 'x' } },
    }));
    const env = await import('../../src/env/manager');
    env.setEnvVars('b1', { API_TOKEN: 'secret' });
    const store = path.join(dataDir, 'bots', 'b1', 'env', 'storage.json');
    fault(store);
    const { createBotRoutes } = await import('../../src/webui/routes/bots');
    const router = createBotRoutes({ clients: new Set() } as any);
    const layer = (router as any).stack.find((l: any) => l.route?.path === '/:id' && l.route.methods.delete);
    const out = { status: 200, body: undefined as any };
    const res = { status(code: number) { out.status = code; return res; }, json(b: any) { out.body = b; return res; } };
    await layer.route.stack[layer.route.stack.length - 1].handle({ params: { id: 'b1' }, query: { keepEnv: 'true' }, body: {} }, res);
    expect(out.status).toBe(409);
    h.faults.clear();
    expect(fs.existsSync(store)).toBe(true);
  });
});
