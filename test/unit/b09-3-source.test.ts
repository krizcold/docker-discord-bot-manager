import { afterAll, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'b09-3-source-'));
  process.env.DATA_DIR = dir;
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => { release = r; });
  return { dir, gate, release: () => release(), clones: 0, opts: [] as unknown[], cloneArgs: [] as string[][] };
});

vi.mock('simple-git', async () => {
  const nodeFs = await import('fs');
  const nodePath = await import('path');
  const make = (...args: unknown[]) => {
    h.opts.push(args.find((a) => a && typeof a === 'object'));
    const client: any = {
      env: () => client,
      clone: async (url: string, target: string, args: string[]) => {
        h.cloneArgs.push(args);
        if (url.includes('stalls')) throw new Error('block timeout reached');
        if (url.includes('noisy')) throw new Error('remote: Enumerating objects: 5321, done.\nremote: Counting objects:   1% (54/5321)\rremote: Counting objects:  50% (2661/5321)\rReceiving objects:  40% (2128/5321), 1.20 MiB | 600.00 KiB/s\rReceiving objects:  41% (2182/5321)\nerror: RPC failed; curl 18 transfer closed\nfatal: early EOF\n');
        h.clones++;
        await h.gate;
        nodeFs.mkdirSync(nodePath.join(target, '.git'), { recursive: true });
      },
      revparse: async () => 'main',
      log: async () => ({ latest: null }),
    };
    return client;
  };
  return { default: make, simpleGit: make };
});

import * as fs from 'fs';
import * as sourceManager from '../../src/source/sourceManager';

afterAll(() => { fs.rmSync(h.dir, { recursive: true, force: true }); });

describe('a source while its first clone runs', () => {
  it('is known by its URL, and a second add of it is refused', async () => {
    const url = 'https://example.invalid/owner/repo.git';
    const first = sourceManager.createSource({ url, branch: 'main' });
    await new Promise((r) => setTimeout(r, 10));
    expect((sourceManager as any).isSourceCloning?.('https://example.invalid/owner/repo')).toBe(true);
    await expect(sourceManager.createSource({ url, branch: 'main' })).rejects.toThrow(/being cloned/);
    expect(h.clones).toBe(1);
    h.release();
    await first;
    expect((sourceManager as any).isSourceCloning?.(url)).toBe(false);
    expect(sourceManager.findSourceByUrl(url)).not.toBeNull();
  });
});

describe('a first clone that fails or stalls', () => {
  it('gives the clone a time limit and releases the URL when the clone fails', async () => {
    const url = 'https://example.invalid/owner/stalls.git';
    await expect(sourceManager.createSource({ url, branch: 'main' })).rejects.toThrow(/timeout/);
    expect(sourceManager.isSourceCloning(url)).toBe(false);
    expect(h.opts.some((o: any) => o && o.timeout && o.timeout.block > 0)).toBe(true);
    expect(h.cloneArgs.length).toBeGreaterThan(0);
    expect(h.cloneArgs.every((a) => a.includes('--progress'))).toBe(true);
  });
});

describe('a clone that fails partway through', () => {
  it('reports the error and fatal lines without the progress output', async () => {
    const url = 'https://example.invalid/owner/noisy.git';
    let msg = '';
    try { await sourceManager.createSource({ url, branch: 'main' }); } catch (e) { msg = String((e as Error).message); }
    expect(msg).toMatch(/fatal: early EOF/);
    expect(msg).toMatch(/error: RPC failed/);
    expect(msg).not.toMatch(/%/);
    expect(msg).not.toMatch(/remote: /);
  });
});
