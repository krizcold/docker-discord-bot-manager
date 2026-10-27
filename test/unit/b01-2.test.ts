import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const tmp = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'b01-2-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return { dir };
});

// Every docker command answers empty; an inspect answers "no such object".
vi.mock('child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('child_process')>();
  const exec = (cmd: string, opts: any, cb?: any) => {
    const done = typeof opts === 'function' ? opts : cb;
    if (cmd.startsWith('docker inspect')) done(new Error('Error: No such object'));
    else done(null, { stdout: '', stderr: '' });
  };
  return { ...real, exec, default: { ...real, exec } };
});
vi.mock('../../src/docker/dockerClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/docker/dockerClient')>()),
  composeDown: async () => {},
  imageExists: async () => false,
  imageState: async () => 'absent',
  removeImage: async () => true,
  listProjectVolumes: () => [],
  removeVolume: () => true,
  checkDockerConnection: async () => true,
  listContainersByBotId: async () => [],
  volumeState: () => 'absent',
}));
vi.mock('../../src/casaos/detector', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/casaos/detector')>()),
  getDeploymentMode: async () => 'docker',
}));
vi.mock('../../src/webui/server', () => ({ broadcastToClients: () => {} }));

import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';
import YAML from 'yaml';
import * as containerManager from '../../src/docker/containerManager';
import * as envManager from '../../src/env/manager';
import { createBotRoutes } from '../../src/webui/routes/bots';

const botsDir = path.join(tmp.dir, 'bots');
const botDir = path.join(botsDir, 'b1');
const envDir = path.join(botDir, 'env');
const composePath = path.join(botDir, 'docker-compose.yml');

const writeRegistry = (): void => {
  fs.writeFileSync(path.join(tmp.dir, 'instances.json'), JSON.stringify({
    instances: {
      b1: {
        id: 'b1', sanitizedName: 'bot1', displayName: 'Bot 1', titleName: 'Bot 1', status: 'stopped',
        sourceType: 'docker-image', envVars: { KEEP_ME: 'k', OLD_FLAG: 'yes', OTHER: 'o' },
        createdAt: '2026-10-22T00:00:00.000Z', updatedAt: '2026-10-22T00:00:00.000Z',
      },
    },
  }));
};

const writeCompose = (env: Record<string, string>): void => {
  fs.writeFileSync(composePath, YAML.stringify({ services: { app: { image: 'fake/app:1', environment: env } } }));
};
const composeEnv = (): Record<string, string> => YAML.parse(fs.readFileSync(composePath, 'utf-8')).services.app.environment;

beforeEach(() => {
  fs.rmSync(botsDir, { recursive: true, force: true });
  fs.mkdirSync(envDir, { recursive: true });
  writeRegistry();
  envManager.setEnvVars('b1', { KEEP_ME: 'k', OLD_FLAG: 'yes', OTHER: 'o', API_TOKEN: 'fake-token-value' });
});

afterAll(() => {
  fs.rmSync(tmp.dir, { recursive: true, force: true });
});

const router = createBotRoutes({ clients: new Set() } as any);
const handler = (method: string, routePath: string) => {
  const layer = (router as any).stack.find((l: any) => l.route?.path === routePath && l.route.methods[method]);
  return layer.route.stack[layer.route.stack.length - 1].handle;
};
const call = async (method: string, routePath: string, req: any): Promise<{ status: number; body: any }> => {
  const out = { status: 200, body: undefined as any };
  const res = { status(code: number) { out.status = code; return res; }, json(body: any) { out.body = body; return res; } };
  await handler(method, routePath)({ query: {}, body: {}, ...req }, res);
  return out;
};

describe('the env editor save', () => {
  it('deletes a removed key from the store, the record and the deployed compose, and names it', async () => {
    writeCompose({ KEEP_ME: 'k', OLD_FLAG: 'yes', OTHER: 'o' });
    const res = await call('put', '/:id/env', {
      params: { id: 'b1' },
      body: { vars: { KEEP_ME: 'k2', OTHER: 'o' }, removed: ['OLD_FLAG'] },
    });
    expect(res.body).toMatchObject({ success: true, removed: ['OLD_FLAG'] });
    expect(envManager.getEnvVars('b1')).toEqual({ KEEP_ME: 'k2', OTHER: 'o', API_TOKEN: 'fake-token-value' });
    expect(containerManager.getBot('b1')?.envVars).toEqual({ KEEP_ME: 'k2', OTHER: 'o' });
    expect(composeEnv()).toEqual({ KEEP_ME: 'k', OTHER: 'o' });
  });

  it('removes a sensitive key too', async () => {
    const res = await call('put', '/:id/env', { params: { id: 'b1' }, body: { vars: {}, removed: ['API_TOKEN'] } });
    expect(res.body).toMatchObject({ success: true, removed: ['API_TOKEN'] });
    expect(envManager.getEnvVars('b1')).not.toHaveProperty('API_TOKEN');
  });

  it('never removes a key the same save keeps, and never claims a key that was not stored', async () => {
    writeCompose({ KEEP_ME: 'k', NEVER_STORED: 'app-default' });
    const res = await call('put', '/:id/env', {
      params: { id: 'b1' },
      body: { vars: { KEEP_ME: 'k' }, removed: ['KEEP_ME', 'NEVER_STORED'] },
    });
    expect(res.body).toMatchObject({ success: true, removed: [] });
    expect(envManager.getEnvVars('b1')).toHaveProperty('KEEP_ME', 'k');
    expect(composeEnv()).toEqual({ KEEP_ME: 'k', NEVER_STORED: 'app-default' });
  });

  it('keeps a key stored when its compose could not be edited, says so, and a second save retries it', async () => {
    fs.mkdirSync(composePath);
    const res = await call('put', '/:id/env', { params: { id: 'b1' }, body: { vars: {}, removed: ['OLD_FLAG'] } });
    expect(res.body.success).toBe(false);
    expect(res.body.removed).toEqual([]);
    expect(res.body.stillStored).toEqual(['OLD_FLAG']);
    expect(res.body.error).toContain(composePath);
    expect(res.body.error).toContain('still stored');
    expect(envManager.getEnvVars('b1')).toHaveProperty('OLD_FLAG', 'yes');
    expect(containerManager.getBot('b1')?.envVars).toHaveProperty('OLD_FLAG', 'yes');

    fs.rmSync(composePath, { recursive: true });
    writeCompose({ OLD_FLAG: 'yes', OTHER: 'o' });
    const again = await call('put', '/:id/env', { params: { id: 'b1' }, body: { vars: {}, removed: ['OLD_FLAG'] } });
    expect(again.body).toMatchObject({ success: true, removed: ['OLD_FLAG'] });
    expect(envManager.getEnvVars('b1')).not.toHaveProperty('OLD_FLAG');
    expect(composeEnv()).toEqual({ OTHER: 'o' });
  });

  it('refuses a removal while a bot operation runs, before anything changes', async () => {
    let release!: () => void;
    const held = containerManager.withExternalBotOp('b1', 'build', () => new Promise<void>((r) => { release = r; }));
    const res = await call('put', '/:id/env', { params: { id: 'b1' }, body: { vars: { OTHER: 'changed' }, removed: ['OLD_FLAG'] } });
    release();
    await held;
    expect(res.status).toBe(409);
    expect(envManager.getEnvVars('b1')).toMatchObject({ OLD_FLAG: 'yes', OTHER: 'o' });
  });
});

describe('removing one env key', () => {
  it('answers an error naming the compose file it could not edit', async () => {
    fs.mkdirSync(composePath);
    const res = await call('delete', '/:id/env/:key', { params: { id: 'b1', key: 'OLD_FLAG' } });
    expect(res.body.success).toBe(false);
    expect(res.body.error).toContain(composePath);
    expect(res.body.error).toContain('still stored');
    expect(envManager.getEnvVars('b1')).toHaveProperty('OLD_FLAG', 'yes');
  });

  it('returns the compose files it could not edit, and edits the others', () => {
    writeCompose({ OLD_FLAG: 'yes', OTHER: 'o' });
    const casaos = path.join(process.env.DATA_ROOT!, 'AppData', 'casaos', 'apps', 'bot1', 'docker-compose.yml');
    fs.mkdirSync(casaos, { recursive: true });
    expect(containerManager.removeEnvKeyFromDeployedCompose('b1', 'OLD_FLAG')).toEqual([casaos]);
    expect(composeEnv()).toEqual({ OTHER: 'o' });
    fs.rmSync(path.join(process.env.DATA_ROOT!), { recursive: true, force: true });
  });
});

describe('Remove with env removal', () => {
  it('deletes exactly the env copies when data is kept, and keeps the config files and the data', async () => {
    writeCompose({ OLD_FLAG: 'yes' });
    fs.writeFileSync(path.join(botDir, '.env'), 'OLD_FLAG=yes\n');
    fs.writeFileSync(path.join(envDir, '.env'), 'OLD_FLAG=yes\n');
    fs.writeFileSync(path.join(envDir, 'storage.json.tmp'), '{}');
    fs.writeFileSync(path.join(envDir, 'storage.json.corrupt-2026-10-22T00-00-00-000Z'), 'x');
    fs.writeFileSync(path.join(envDir, 'configFiles.json'), '{"files":[]}');
    fs.mkdirSync(path.join(botDir, 'data'));
    fs.writeFileSync(path.join(botDir, 'data', 'user.db'), 'fake data');
    const res = await call('delete', '/:id', { params: { id: 'b1' }, query: { keepData: 'true', keepEnv: 'false' } });
    expect(res.body).toMatchObject({ success: true, envDeleted: true, vaulted: false });
    expect(fs.readdirSync(envDir)).toEqual(['configFiles.json']);
    expect(fs.existsSync(path.join(botDir, '.env'))).toBe(false);
    expect(fs.readFileSync(path.join(botDir, 'data', 'user.db'), 'utf8')).toBe('fake data');
  });

  it('keeps the stored env when env removal is not asked', async () => {
    const res = await call('delete', '/:id', { params: { id: 'b1' }, query: { keepData: 'true', keepEnv: 'true' } });
    expect(res.body.success).toBe(true);
    expect(res.body.envDeleted).toBe(false);
    expect(fs.existsSync(path.join(envDir, 'storage.json'))).toBe(true);
  });
});

describe('renaming a stored secret in the editor', () => {
  it('carries the stored value to the new name', async () => {
    const res = await call('put', '/:id/env', {
      params: { id: 'b1' },
      body: { vars: {}, removed: ['API_TOKEN'], renamed: { BOT_TOKEN: 'API_TOKEN' } },
    });
    expect(res.body).toMatchObject({ success: true, removed: ['API_TOKEN'] });
    const env = envManager.getEnvVars('b1');
    expect(env).toHaveProperty('BOT_TOKEN', 'fake-token-value');
    expect(env).not.toHaveProperty('API_TOKEN');
  });

  it('keeps a value typed for the new name', async () => {
    const res = await call('put', '/:id/env', {
      params: { id: 'b1' },
      body: { vars: { BOT_TOKEN: 'fake-typed' }, removed: ['API_TOKEN'], renamed: { BOT_TOKEN: 'API_TOKEN' } },
    });
    expect(res.body.success).toBe(true);
    expect(envManager.getEnvVars('b1')).toHaveProperty('BOT_TOKEN', 'fake-typed');
  });

  it('refuses with nothing changed when the old value cannot be carried', async () => {
    const res = await call('put', '/:id/env', {
      params: { id: 'b1' },
      body: { vars: { OTHER: 'changed' }, removed: ['NOT_STORED_SECRET'], renamed: { NEW_SECRET: 'NOT_STORED_SECRET' } },
    });
    expect(res.status).toBe(409);
    expect(res.body.success).toBe(false);
    expect(envManager.getEnvVars('b1')).toEqual({ KEEP_ME: 'k', OLD_FLAG: 'yes', OTHER: 'o', API_TOKEN: 'fake-token-value' });
  });
});

// A named function's source from the page's inline script, by balanced braces.
const pageHtml = fs.readFileSync(path.resolve(__dirname, '../../src/webui/public/index.html'), 'utf8');
const pageFunction = (name: string): string => {
  let start = pageHtml.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`no function ${name}`);
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
const runPage = (names: string[], globals: Record<string, unknown>): vm.Context => {
  const ctx = vm.createContext({ ...globals });
  vm.runInContext(names.map(pageFunction).join('\n'), ctx);
  return ctx;
};

type FakeRow = { key: string; value: string; sensitive?: boolean; originalKey?: string };
const editorPage = (rows: FakeRow[], stored: string[], answer: any) => {
  const sent: any[] = [];
  const messages: string[][] = [];
  const els = rows.map((r) => {
    const key = { value: r.key, dataset: r.originalKey ? { originalKey: r.originalKey } : {} };
    const val = { value: r.value, dataset: r.sensitive ? { sensitive: 'true' } : {} };
    return { classList: { contains: () => false }, querySelector: (s: string) => (s === '.env-key' ? key : s === '.env-value' ? val : null) };
  });
  const btn = { disabled: false, textContent: 'Save', isConnected: true };
  const ctx = runPage(['botLabel', 'envEditorRemovedKeys', 'semanticWrapper', 'semanticEnvValue', 'saveEnvEditor'], {
    document: { querySelectorAll: () => els, querySelector: () => btn, getElementById: () => ({ classList: { contains: () => false }, querySelector: () => null }) },
    semanticEnvKey: () => null,
    envEditorInitial: {},
    envEditorStored: stored,
    envEditorBotId: 'b1',
    envEditorSeq: 0,
    bots: [],
    api: async (method: string, url: string, body: any) => { sent.push({ method, url, body }); return answer; },
    showMessage: (type: string, text: string) => { messages.push([type, text]); },
    hideEnvEditor: () => {},
    loadBots: () => {},
    confirm: () => true,
  });
  return { save: () => (ctx as any).saveEnvEditor(), sent, messages };
};

describe('the env editor page', () => {
  it('parses', () => {
    const scripts = [...pageHtml.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    expect(scripts.length).toBeGreaterThan(0);
    for (const src of scripts) expect(() => new Function(src)).not.toThrow();
  });

  it('sends the stored keys whose rows were removed or renamed, and names what the server removed', async () => {
    const page = editorPage(
      [{ key: 'A', value: '1', originalKey: 'A' }, { key: 'C2', value: '3', originalKey: 'C' }, { key: 'NEW', value: 'n' }],
      ['A', 'B', 'C'],
      { success: true, removed: ['B', 'C'] },
    );
    await page.save();
    expect(page.sent).toHaveLength(1);
    expect(page.sent[0].body.vars).toEqual({ A: '1', C2: '3', NEW: 'n' });
    expect(page.sent[0].body.removed).toEqual(['B', 'C']);
    expect(page.sent[0].body.renamed).toEqual({});
    expect(page.messages).toEqual([['success', 'Environment variables of b1 saved; removed B, C']]);
  });

  it('sends a renamed blank secret as a rename, never as a blank value', async () => {
    const page = editorPage(
      [{ key: 'BOT_TOKEN', value: '', sensitive: true, originalKey: 'API_TOKEN' }],
      ['API_TOKEN'],
      { success: true, removed: ['API_TOKEN'] },
    );
    await page.save();
    expect(page.sent[0].body.vars).toEqual({});
    expect(page.sent[0].body.removed).toEqual(['API_TOKEN']);
    expect(page.sent[0].body.renamed).toEqual({ BOT_TOKEN: 'API_TOKEN' });
  });

  it('shows the server error when a key stays stored', async () => {
    const page = editorPage([], ['A'], { success: false, removed: [], stillStored: ['A'], error: 'could not edit x, so A is still stored' });
    await page.save();
    expect(page.messages).toEqual([['error', 'b1: could not edit x, so A is still stored']]);
  });
});

describe('the Remove toast', () => {
  const removePage = (env: boolean, answer: any) => {
    const messages: string[][] = [];
    const checks: Record<string, boolean> = { 'delete-also-data': false, 'delete-also-env': env };
    const ctx = runPage(['confirmDeleteBot'], {
      bots: [], deleteBotId: 'b1', busyBots: new Set(), isTransientStatus: () => false,
      document: { getElementById: (id: string) => ({ checked: checks[id] }) },
      hideDeleteModal: () => {}, renderBots: () => {}, loadBots: () => {},
      api: async () => answer,
      showMessage: (type: string, text: string) => { messages.push([type, text]); },
    });
    return { run: () => (ctx as any).confirmDeleteBot(), messages };
  };

  it('says deleted only when the server confirmed it', async () => {
    const yes = removePage(true, { success: true, envDeleted: true });
    await yes.run();
    expect(yes.messages).toEqual([['success', 'Bot removed (data preserved); environment values deleted']]);
    const unsure = removePage(true, { success: true, envDeleted: false });
    await unsure.run();
    expect(unsure.messages[0][1]).toContain('could not be confirmed');
  });

  it('says copied to the vault when the values were kept', async () => {
    const kept = removePage(false, { success: true, vaulted: true, envDeleted: false });
    await kept.run();
    expect(kept.messages).toEqual([['success', 'Bot removed (data preserved); environment values copied to the vault']]);
  });
});

describe('a rename that would overwrite', () => {
  it('refuses with nothing saved when the new name is already stored', async () => {
    const res = await call('put', '/:id/env', {
      params: { id: 'b1' },
      body: { vars: { OTHER: 'changed' }, removed: ['API_TOKEN'], renamed: { KEEP_ME: 'API_TOKEN' } },
    });
    expect(res.status).toBe(409);
    expect(envManager.getEnvVars('b1')).toEqual({ KEEP_ME: 'k', OLD_FLAG: 'yes', OTHER: 'o', API_TOKEN: 'fake-token-value' });
  });

  it('is refused by the page when two rows hold the same key', async () => {
    const page = editorPage(
      [{ key: 'SAME', value: '', sensitive: true, originalKey: 'API_TOKEN' }, { key: 'SAME', value: 'x' }],
      ['API_TOKEN'],
      { success: true },
    );
    await page.save();
    expect(page.sent).toHaveLength(0);
    expect(page.messages[0][0]).toBe('error');
    expect(page.messages[0][1]).toContain('SAME');
  });
});

describe('renames that free their own target', () => {
  beforeEach(() => {
    envManager.setEnvVars('b1', { A_SECRET: 'fake-a', B_SECRET: 'fake-b' });
  });

  it('swaps two stored secrets with the values from before the save', async () => {
    const res = await call('put', '/:id/env', {
      params: { id: 'b1' },
      body: { vars: {}, removed: ['A_SECRET', 'B_SECRET'], renamed: { B_SECRET: 'A_SECRET', A_SECRET: 'B_SECRET' } },
    });
    expect(res.body.success).toBe(true);
    expect(envManager.getEnvVars('b1')).toMatchObject({ A_SECRET: 'fake-b', B_SECRET: 'fake-a' });
  });

  it('follows a chain', async () => {
    const res = await call('put', '/:id/env', {
      params: { id: 'b1' },
      body: { vars: {}, removed: ['A_SECRET', 'B_SECRET'], renamed: { B_SECRET: 'A_SECRET', C_SECRET: 'B_SECRET' } },
    });
    expect(res.body.success).toBe(true);
    const env = envManager.getEnvVars('b1');
    expect(env).toMatchObject({ B_SECRET: 'fake-a', C_SECRET: 'fake-b' });
    expect(env).not.toHaveProperty('A_SECRET');
  });

  it('renames onto a stored name whose row was deleted', async () => {
    const res = await call('put', '/:id/env', {
      params: { id: 'b1' },
      body: { vars: {}, removed: ['OTHER', 'API_TOKEN'], renamed: { OTHER: 'API_TOKEN' } },
    });
    expect(res.body.success).toBe(true);
    const env = envManager.getEnvVars('b1');
    expect(env).toHaveProperty('OTHER', 'fake-token-value');
    expect(env).not.toHaveProperty('API_TOKEN');
  });

  it('the page sends a deleted row as removed even when another row is renamed onto its name', async () => {
    const page = editorPage(
      [{ key: 'OTHER', value: '', sensitive: true, originalKey: 'API_TOKEN' }],
      ['OTHER', 'API_TOKEN'],
      { success: true, removed: ['API_TOKEN'] },
    );
    await page.save();
    expect(page.sent[0].body.removed).toEqual(['OTHER', 'API_TOKEN']);
    expect(page.sent[0].body.renamed).toEqual({ OTHER: 'API_TOKEN' });
  });
});
