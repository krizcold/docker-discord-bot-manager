import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'b08-2-'));
  process.env.DATA_DIR = dir;
  return {
    dir,
    events: [] as string[],
    head: 'a'.repeat(40),
    remote: 'a'.repeat(40),
    fetchGate: null as Promise<void> | null,
    failCopy: false,
  };
});

// A fake git: fetch can be held on a gate, status reports behind when the
// remote moved, and a hard reset moves HEAD to the remote.
vi.mock('simple-git', async () => {
  const nodeFs = await import('fs');
  const nodePath = await import('path');
  const make = () => {
    const client: any = {
      env: () => client,
      clone: async (_url: string, target: string) => {
        nodeFs.mkdirSync(nodePath.join(target, '.git'), { recursive: true });
        nodeFs.writeFileSync(nodePath.join(target, 'index.js'), 'x');
      },
      fetch: async () => {
        h.events.push('fetch-start');
        if (h.fetchGate) await h.fetchGate;
        h.events.push('fetch-end');
      },
      status: async () => ({ behind: h.head === h.remote ? 0 : 1, ahead: 0, files: [] }),
      revparse: async (args: string[]) => (args[0] === 'HEAD' ? h.head : 'main'),
      log: async () => ({ latest: { hash: h.head, message: 'm', date: 'd' } }),
      raw: async (args: string[]) => { if (args[0] === 'reset') h.head = h.remote; return ''; },
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
  return { ...real, copyFileSync, default: { ...real, copyFileSync } };
});

import * as fs from 'fs';
import * as path from 'path';
import * as sourceManager from '../../src/source/sourceManager';

beforeEach(() => {
  h.events.length = 0;
  h.fetchGate = null;
  h.failCopy = false;
});

afterAll(() => {
  fs.rmSync(h.dir, { recursive: true, force: true });
});
let sourceCount = 0;

async function newSource(): Promise<string> {
  const s = await sourceManager.createSource({ url: `https://example.invalid/o/r${++sourceCount}.git`, branch: 'main' });
  return s.id;
}

describe('the per-source checkout lock', () => {
  it('runs two fetches of one source one after the other', async () => {
    const id = await newSource();
    let open!: () => void;
    h.fetchGate = new Promise<void>(r => { open = r; });
    const a = sourceManager.fetchSource(id);
    const b = sourceManager.fetchSource(id);
    await new Promise(r => setTimeout(r, 20));
    open();
    await Promise.all([a, b]);
    expect(h.events).toEqual(['fetch-start', 'fetch-end', 'fetch-start', 'fetch-end']);
  });

  it('holds a fetch off while a build holds the checkout', async () => {
    const id = await newSource();
    let release!: () => void;
    const held = sourceManager.withSourceLock(id, async () => {
      h.events.push('build-start');
      await new Promise<void>(r => { release = r; });
      h.events.push('build-end');
    });
    const f = sourceManager.fetchSource(id);
    await new Promise(r => setTimeout(r, 20));
    release();
    await Promise.all([held, f]);
    expect(h.events).toEqual(['build-start', 'build-end', 'fetch-start', 'fetch-end']);
  });
});

describe('a fetch that moves the checkout', () => {
  it('records the new commit and reports a failed raw copy on its own', async () => {
    const id = await newSource();
    h.remote = 'b'.repeat(40);
    h.failCopy = true;
    const result = await sourceManager.fetchSource(id);
    expect(result.hasUpdates).toBe(true);
    expect(result.copyError).toContain('raw copy');
    expect(result.copyError).toContain('bbbbbbb');
    expect(sourceManager.getSource(id)!.lastCommitHash).toBe('b'.repeat(40));
    expect(await sourceManager.readSourceHead(id)).toBe('b'.repeat(40));
  });
});

describe('the raw copy of a source', () => {
  it('keeps a symlink as a link', async () => {
    const id = await newSource();
    const repo = sourceManager.getSourceRepoPath(id);
    try {
      fs.symlinkSync('index.js', path.join(repo, 'link.js'));
    } catch {
      return; // this host cannot make symlinks (win32 without the privilege); Linux runs the row
    }
    h.remote = 'c'.repeat(40);
    const result = await sourceManager.fetchSource(id);
    expect(result.copyError).toBeUndefined();
    const copied = path.join(sourceManager.getSourceRawPath(id), 'link.js');
    expect(fs.lstatSync(copied).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(copied)).toBe('index.js');
  });
});
