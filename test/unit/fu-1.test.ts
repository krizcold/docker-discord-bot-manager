import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'fu-1-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  delete process.env.ENV_ENCRYPTION_KEY;
  return { dir, renameFaults: new Set<string>() };
});

vi.mock('fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('fs')>();
  const nodePath = require('path') as typeof import('path');
  const wrapped = {
    ...real,
    renameSync: (a: any, b: any) => {
      if (typeof b === 'string' && h.renameFaults.has(nodePath.resolve(b))) {
        throw Object.assign(new Error(`EPERM: injected, rename '${a}' -> '${b}'`), { code: 'EPERM', syscall: 'rename' });
      }
      return real.renameSync(a, b);
    },
  };
  return { ...wrapped, default: wrapped };
});

vi.mock('child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('child_process')>();
  const exec = (_cmd: string, opts: any, cb?: any) => {
    const done = typeof opts === 'function' ? opts : cb;
    done(null, { stdout: '', stderr: '' });
  };
  const execFile = (_cmd: string, _args: string[], optsOrCb: unknown, maybeCb?: unknown) => {
    const cb = (typeof optsOrCb === 'function' ? optsOrCb : maybeCb) as (err: Error | null, stdout: string, stderr: string) => void;
    cb(null, '', '');
  };
  return { ...real, exec, execFile, default: { ...real, exec, execFile } };
});

vi.mock('simple-git', async () => {
  const nodeFs = await import('fs');
  const nodePath = await import('path');
  const make = () => {
    const client: any = {
      env: () => client,
      clone: async (_url: string, target: string) => { nodeFs.mkdirSync(nodePath.join(target, '.git'), { recursive: true }); },
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
vi.mock('../../src/webui/server', () => ({ broadcastToClients: () => {} }));

import * as fs from 'fs';
import * as path from 'path';
import * as envManager from '../../src/env/manager';
import * as configFileManager from '../../src/config/configFileManager';
import * as sourceManager from '../../src/source/sourceManager';
import * as containerManager from '../../src/docker/containerManager';

const REGISTRY = path.join(h.dir, 'instances.json');
const SOURCES = path.join(h.dir, 'sources.json');
const envDir = (botId: string) => path.join(h.dir, 'bots', botId, 'env');

afterAll(() => { fs.rmSync(h.dir, { recursive: true, force: true }); });
beforeEach(() => {
  h.renameFaults.clear();
  vi.restoreAllMocks();
  fs.rmSync(REGISTRY, { force: true });
  fs.rmSync(`${REGISTRY}.tmp`, { force: true });
});

/** Run the write with the rename onto target failing, and check what it leaves. */
function expectFailedRename(target: string, write: () => void): void {
  const before = fs.readFileSync(target, 'utf-8');
  h.renameFaults.add(path.resolve(target));
  vi.spyOn(console, 'error').mockImplementation(() => {});
  let thrown: any = null;
  try { write(); } catch (err) { thrown = err; }
  expect(thrown).not.toBeNull();
  expect(thrown.code).toBe('EPERM');
  expect(String(thrown.message)).toMatch(/injected/);
  expect(fs.existsSync(`${target}.tmp`)).toBe(false);
  expect(fs.readFileSync(target, 'utf-8')).toBe(before);
}

function seedRegistry(instances: Record<string, Record<string, unknown>>): void {
  fs.writeFileSync(REGISTRY, JSON.stringify({ instances }, null, 2));
}

describe('FU-1 a failed rename leaves no tmp, the target unchanged and the original error thrown', () => {
  it('saveEnvStorage (storage.json)', () => {
    envManager.setEnvVars('envbot', { PLAIN: 'one' });
    const target = path.join(envDir('envbot'), 'storage.json');
    expectFailedRename(target, () => envManager.setEnvVars('envbot', { PLAIN: 'two' }));
    expect(envManager.getEnvVars('envbot').PLAIN).toBe('one');
  });

  it('saveRegistrySync (instances.json)', () => {
    seedRegistry({ a: { id: 'a', displayName: 'a', sourceId: null, sourceUrl: 'x', autoUpdate: false } });
    expectFailedRename(REGISTRY, () => containerManager.updateInstanceAutoUpdate('a', true));
    expect(containerManager.getBot('a')?.autoUpdate).toBe(false);
  });

  it('setConfigFiles (configFiles.json)', () => {
    configFileManager.setConfigFiles('cfgbot', [{ path: 'a.json', body: '{"v":1}' } as any]);
    const target = path.join(envDir('cfgbot'), 'configFiles.json');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    expectFailedRename(target, () => configFileManager.setConfigFiles('cfgbot', [{ path: 'a.json', body: '{"v":2}' } as any]));
    expect(configFileManager.getConfigFiles('cfgbot')[0].body).toBe('{"v":1}');
  });

  it('setBuiltMounts (builtMounts.json)', () => {
    configFileManager.setBuiltMounts('mntbot', ['a.json:ro']);
    const target = path.join(envDir('mntbot'), 'builtMounts.json');
    expectFailedRename(target, () => configFileManager.setBuiltMounts('mntbot', ['b.json:rw']));
    expect(configFileManager.getBuiltMounts('mntbot')).toEqual(['a.json:ro']);
  });

  it('setDeliveredOverrides (deliveredConfig.json)', () => {
    configFileManager.setDeliveredOverrides('dlvbot', { 'a.json': 'h1' });
    const target = path.join(envDir('dlvbot'), 'deliveredConfig.json');
    expectFailedRename(target, () => configFileManager.setDeliveredOverrides('dlvbot', { 'a.json': 'h2' }));
    expect(configFileManager.getDeliveredOverrides('dlvbot')).toEqual({ 'a.json': 'h1' });
  });

  it('saveSourceRegistry (sources.json)', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const made = await sourceManager.createSource({ url: 'https://example.invalid/o/plain.git', branch: 'main' });
    expectFailedRename(SOURCES, () => sourceManager.updateSource(made.id, { autoUpdate: false }));
    expect(sourceManager.getSource(made.id)?.autoUpdate).toBe(true);
  });

  it('reAssociateInstances (instances.json): no tmp, the registry unchanged, the source still created', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    seedRegistry({ o: { id: 'o', displayName: 'o', sourceId: null, sourceUrl: 'https://example.invalid/o/renamefault' } });
    const before = fs.readFileSync(REGISTRY, 'utf-8');
    h.renameFaults.add(path.resolve(REGISTRY));
    const made = await sourceManager.createSource({ url: 'https://example.invalid/o/renamefault.git', branch: 'main' });
    expect(sourceManager.getSource(made.id)).toBeTruthy();
    expect(fs.existsSync(`${REGISTRY}.tmp`)).toBe(false);
    expect(fs.readFileSync(REGISTRY, 'utf-8')).toBe(before);
    expect(warn.mock.calls.map(c => c.join(' ')).join('\n')).toMatch(/injected/);
  });
});

describe('FU-1 reAssociateInstances goes through the registry guards', () => {
  it('with instances.json unreadable it writes nothing and logs why', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    fs.writeFileSync(REGISTRY, '{"instances": {"o": {"id": "o", "sourceId": null, "sourceUrl": "https://example.invalid/o/broken"');
    const before = fs.readFileSync(REGISTRY, 'utf-8');
    await sourceManager.createSource({ url: 'https://example.invalid/o/broken.git', branch: 'main' });
    expect(fs.readFileSync(REGISTRY, 'utf-8')).toBe(before);
    expect(fs.existsSync(`${REGISTRY}.tmp`)).toBe(false);
    expect(warn.mock.calls.map(c => c.join(' ')).join('\n')).toMatch(/instances\.json\) cannot be read/);
  });

  it('a re-association shows in getBot at once, is kept by the next registry save and is saved through the registry boundary', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    seedRegistry({
      o: { id: 'o', displayName: 'o', sourceId: null, sourceUrl: 'https://example.invalid/o/match', updateToken: 'plain-token' },
      other: { id: 'other', displayName: 'other', sourceId: null, sourceUrl: 'https://example.invalid/o/elsewhere', autoUpdate: false },
    });
    const made = await sourceManager.createSource({ url: 'https://example.invalid/o/match.git', branch: 'main' });
    expect(containerManager.getBot('o')?.sourceId).toBe(made.id);
    expect(containerManager.getBot('o')?.updateToken).toBe('plain-token');
    expect(containerManager.getBot('other')?.sourceId).toBeNull();
    const onDisk = JSON.parse(fs.readFileSync(REGISTRY, 'utf-8')).instances;
    expect(onDisk.o.sourceId).toBe(made.id);
    expect(String(onDisk.o.updateToken)).toMatch(/^v2:/);
    containerManager.updateInstanceAutoUpdate('other', true);
    expect(containerManager.getBot('o')?.sourceId).toBe(made.id);
    expect(containerManager.getBot('other')?.autoUpdate).toBe(true);
  });
});
