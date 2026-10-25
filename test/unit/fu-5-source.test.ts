import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'fu-5-source-'));
  process.env.DATA_DIR = dir;
  return { dir, failCopy: false, failCompose: false, failClone: false };
});

vi.mock('simple-git', async () => {
  const nodeFs = await import('fs');
  const nodePath = await import('path');
  const make = () => {
    const client: any = {
      env: () => client,
      clone: async (_url: string, target: string) => {
        nodeFs.mkdirSync(nodePath.join(target, '.git'), { recursive: true });
        nodeFs.writeFileSync(nodePath.join(target, 'index.js'), 'x');
        nodeFs.writeFileSync(nodePath.join(target, 'docker-compose.yml'), 'services: {}\n');
        if (h.failClone) throw new Error('fatal: early EOF');
      },
      revparse: async (args: string[]) => (args[0] === 'HEAD' ? 'a'.repeat(40) : 'main'),
      log: async () => ({ latest: { hash: 'a'.repeat(40), message: 'm', date: 'd' } }),
    };
    return client;
  };
  return { default: make, simpleGit: make };
});

vi.mock('fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('fs')>();
  const copyFileSync = (...a: Parameters<typeof real.copyFileSync>) => {
    if (h.failCopy) throw new Error('disk full');
    return real.copyFileSync(...a);
  };
  const writeFileSync = (...a: Parameters<typeof real.writeFileSync>) => {
    if (h.failCompose && String(a[0]).endsWith('original-compose.yml')) throw new Error('disk full');
    return real.writeFileSync(...a);
  };
  return { ...real, copyFileSync, writeFileSync, default: { ...real, copyFileSync, writeFileSync } };
});

import * as fs from 'fs';
import * as path from 'path';
import * as sourceManager from '../../src/source/sourceManager';

const sourcesDir = path.join(h.dir, 'sources');
const leftDirs = (): string[] => (fs.existsSync(sourcesDir) ? fs.readdirSync(sourcesDir).filter(n => fs.statSync(path.join(sourcesDir, n)).isDirectory()) : []);

let n = 0;
const url = (): string => `https://example.invalid/o/r${++n}.git`;

beforeEach(() => {
  h.failCopy = false;
  h.failCompose = false;
  h.failClone = false;
  fs.rmSync(sourcesDir, { recursive: true, force: true });
});

afterAll(() => {
  fs.rmSync(h.dir, { recursive: true, force: true });
});

describe('a new source whose copies fail', () => {
  it('leaves no source folder and no registry entry when the raw copy fails, and says which copy failed', async () => {
    h.failCopy = true;
    const u = url();
    await expect(sourceManager.createSource({ url: u, branch: 'main' })).rejects.toThrow(/raw copy/);
    expect(leftDirs()).toEqual([]);
    expect(sourceManager.getAllSources().some(s => s.url === u)).toBe(false);
  });

  it('leaves no source folder and no registry entry when the compose copy fails', async () => {
    h.failCompose = true;
    const u = url();
    await expect(sourceManager.createSource({ url: u, branch: 'main' })).rejects.toThrow(/compose copy/);
    expect(leftDirs()).toEqual([]);
    expect(sourceManager.getAllSources().some(s => s.url === u)).toBe(false);
  });

  it('leaves no half clone behind when the clone fails', async () => {
    h.failClone = true;
    await expect(sourceManager.createSource({ url: url(), branch: 'main' })).rejects.toThrow(/early EOF/);
    expect(leftDirs()).toEqual([]);
  });

  it('registers a source whose copies all succeed, with both copies on disk', async () => {
    const s = await sourceManager.createSource({ url: url(), branch: 'main' });
    expect(sourceManager.getSource(s.id)?.lastCommitHash).toBe('a'.repeat(40));
    expect(fs.existsSync(path.join(sourceManager.getSourceRawPath(s.id), 'index.js'))).toBe(true);
    expect(fs.existsSync(sourceManager.getOriginalComposePath(s.id))).toBe(true);
  });
});
