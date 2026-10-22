import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Hooks into fs: a path whose stat fails as if unreadable, and a write that is
// cut short as if the manager were killed mid-write.
const h = vi.hoisted(() => ({ statFails: '' as string, tornWrite: false, closeFails: false }));

vi.mock('fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('fs')>();
  const eacces = (p: fs.PathLike) => Object.assign(new Error(`EACCES: permission denied, stat '${p}'`), { code: 'EACCES' });
  const hit = (p: fs.PathLike) => h.statFails !== '' && path.resolve(String(p)) === path.resolve(h.statFails);
  const existsSync = (p: fs.PathLike) => (hit(p) ? false : real.existsSync(p));
  const statSync = ((p: fs.PathLike, o?: any) => { if (hit(p)) throw eacces(p); return real.statSync(p, o); }) as typeof fs.statSync;
  const lstatSync = ((p: fs.PathLike, o?: any) => { if (hit(p)) throw eacces(p); return real.lstatSync(p, o); }) as typeof fs.lstatSync;
  const writeFileSync = ((p: any, data: any, o?: any) => {
    if (h.tornWrite) {
      real.writeFileSync(p, Buffer.from(data).subarray(0, 3), o);
      throw new Error('killed mid-write');
    }
    return real.writeFileSync(p, data, o);
  }) as typeof fs.writeFileSync;
  const writeSync = ((fd: number, buf: any, ...rest: any[]) => {
    if (h.tornWrite) {
      real.writeSync(fd, Buffer.from(buf).subarray(0, 3));
      throw new Error('killed mid-write');
    }
    return (real.writeSync as any)(fd, buf, ...rest);
  }) as typeof fs.writeSync;
  const closeSync = ((fd: number) => {
    real.closeSync(fd);
    if (h.closeFails) throw Object.assign(new Error('EIO: close failed'), { code: 'EIO' });
  }) as typeof fs.closeSync;
  const over = { existsSync, statSync, lstatSync, writeFileSync, writeSync, closeSync };
  return { ...real, ...over, default: { ...real, ...over } };
});

import { createVolumeDirectories, prepareDockerBotFiles } from '../../src/templates/pcsProcessing';

const SEED = 'server:\n  port: 2333\n';

let tmp: string;
let repo: string;
let logs: string[];
const savedDataRoot = process.env.DATA_ROOT;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'b17-2-'));
  repo = path.join(tmp, 'repo');
  fs.mkdirSync(repo);
  fs.writeFileSync(path.join(repo, 'application.yml'), SEED);
  fs.mkdirSync(path.join(repo, 'conf'));
  fs.writeFileSync(path.join(repo, 'conf', 'inner.yml'), SEED);
  logs = [];
  h.statFails = '';
  h.tornWrite = false;
  h.closeFails = false;
});

afterEach(() => {
  h.closeFails = false;
  h.statFails = '';
  h.tornWrite = false;
  if (savedDataRoot === undefined) delete process.env.DATA_ROOT; else process.env.DATA_ROOT = savedDataRoot;
  fs.rmSync(tmp, { recursive: true, force: true });
});

const fwd = (p: string) => p.replace(/\\/g, '/');

// Both delivery paths, driven through their public entry points. `deliver`
// prepares the compose's binds; `target` is where a repo entry lands.
const paths = [
  {
    name: 'docker mode (prepareDockerBotFiles)',
    target: (rel: string) => path.join(tmp, 'bot', rel),
    deliver: async (rel: string) => {
      const compose = `services:\n  app:\n    image: x\n    volumes:\n      - type: bind\n        source: /host/bot/${rel}\n        target: /app/${rel}\n`;
      prepareDockerBotFiles(compose, path.join(tmp, 'bot'), '/host/bot', repo, [], (m) => logs.push(m));
    },
  },
  {
    name: 'platform mode (createVolumeDirectories)',
    target: (rel: string) => path.join(tmp, 'DATA', 'AppData', 'app1', rel),
    deliver: async (rel: string) => {
      process.env.DATA_ROOT = fwd(path.join(tmp, 'DATA'));
      const src = `${fwd(path.join(tmp, 'DATA'))}/AppData/app1/${rel}`;
      const compose = `services:\n  app:\n    image: x\n    volumes:\n      - type: bind\n        source: ${src}\n        target: /app/${rel}\n`;
      await createVolumeDirectories(compose, 'app1', repo, (m) => logs.push(m));
    },
  },
];

const noStrays = (dir: string) => fs.readdirSync(dir).filter((n) => n.startsWith('.'));

describe.each(paths)('B17-2 repo seed delivery, $name', (p) => {
  it('delivers a missing file whole', async () => {
    await p.deliver('application.yml');
    expect(fs.readFileSync(p.target('application.yml'), 'utf8')).toBe(SEED);
    expect(logs.some((l) => l.includes('Delivered file') && l.includes('application.yml'))).toBe(true);
  });

  it('keeps an existing non-empty file and says so', async () => {
    fs.mkdirSync(path.dirname(p.target('application.yml')), { recursive: true });
    fs.writeFileSync(p.target('application.yml'), 'operator edit\n');
    await p.deliver('application.yml');
    expect(fs.readFileSync(p.target('application.yml'), 'utf8')).toBe('operator edit\n');
    expect(logs.some((l) => l.includes('Kept existing file') && l.includes('application.yml'))).toBe(true);
    expect(logs.some((l) => l.includes('Delivered file'))).toBe(false);
  });

  it('keeps an existing empty file (an operator may have emptied it on purpose)', async () => {
    fs.mkdirSync(path.dirname(p.target('application.yml')), { recursive: true });
    fs.writeFileSync(p.target('application.yml'), '');
    const ino = fs.statSync(p.target('application.yml')).ino;
    await p.deliver('application.yml');
    expect(fs.readFileSync(p.target('application.yml'), 'utf8')).toBe('');
    expect(fs.statSync(p.target('application.yml')).ino).toBe(ino);
    expect(logs.some((l) => l.includes('Kept existing file'))).toBe(true);
  });

  it('never removes a non-empty directory where the repo ships a file', async () => {
    fs.mkdirSync(p.target('application.yml'), { recursive: true });
    fs.writeFileSync(path.join(p.target('application.yml'), 'keep.txt'), 'data');
    await p.deliver('application.yml');
    expect(fs.readFileSync(path.join(p.target('application.yml'), 'keep.txt'), 'utf8')).toBe('data');
    expect(logs.some((l) => /not empty|non-empty/i.test(l) && l.includes('application.yml'))).toBe(true);
    expect(logs.some((l) => l.includes('Delivered file'))).toBe(false);
  });

  it('replaces an empty directory (one Docker made at a file path) with the file', async () => {
    fs.mkdirSync(p.target('application.yml'), { recursive: true });
    await p.deliver('application.yml');
    expect(fs.readFileSync(p.target('application.yml'), 'utf8')).toBe(SEED);
  });

  it('delivers nothing over a target it cannot inspect', async () => {
    fs.mkdirSync(path.dirname(p.target('application.yml')), { recursive: true });
    fs.writeFileSync(p.target('application.yml'), 'operator edit\n');
    h.statFails = p.target('application.yml');
    await p.deliver('application.yml');
    h.statFails = '';
    expect(fs.readFileSync(p.target('application.yml'), 'utf8')).toBe('operator edit\n');
    expect(logs.some((l) => l.includes('Delivered file'))).toBe(false);
    expect(logs.some((l) => l.includes('EACCES'))).toBe(true);
  });

  it('a write cut short leaves no target and no temp file, so the next Start delivers it whole', async () => {
    h.tornWrite = true;
    await p.deliver('application.yml');
    h.tornWrite = false;
    expect(fs.existsSync(p.target('application.yml'))).toBe(false);
    expect(noStrays(path.dirname(p.target('application.yml')))).toEqual([]);
    expect(logs.some((l) => l.includes('Delivered file'))).toBe(false);
    logs = [];
    await p.deliver('application.yml');
    expect(fs.readFileSync(p.target('application.yml'), 'utf8')).toBe(SEED);
  });

  it('a directory seed keeps an existing empty child and fills a missing one', async () => {
    fs.mkdirSync(p.target('conf'), { recursive: true });
    fs.writeFileSync(path.join(p.target('conf'), 'inner.yml'), '');
    fs.writeFileSync(path.join(repo, 'conf', 'second.yml'), SEED);
    await p.deliver('conf');
    expect(fs.readFileSync(path.join(p.target('conf'), 'inner.yml'), 'utf8')).toBe('');
    expect(fs.readFileSync(path.join(p.target('conf'), 'second.yml'), 'utf8')).toBe(SEED);
    expect(logs.some((l) => l.includes('Kept existing file') && l.includes('inner.yml'))).toBe(true);
    expect(noStrays(p.target('conf'))).toEqual([]);
  });

  it('a close that fails leaves no temp file and no target', async () => {
    h.closeFails = true;
    await p.deliver('application.yml');
    h.closeFails = false;
    expect(fs.existsSync(p.target('application.yml'))).toBe(false);
    expect(noStrays(path.dirname(p.target('application.yml')))).toEqual([]);
    expect(logs.some((l) => l.includes('Delivered file'))).toBe(false);
  });

  it('removes a temp file a killed earlier seed of the same target left, and nothing else', async () => {
    const dir = path.dirname(p.target('application.yml'));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '.application.yml.smdb-seed.4242.0a1b2c3d'), 'ser');
    fs.writeFileSync(path.join(dir, '.application.yml.smdb-seed.notes'), 'mine');
    fs.writeFileSync(path.join(dir, '.other.yml.smdb-seed.4242.0a1b2c3d'), 'other');
    await p.deliver('application.yml');
    expect(fs.readFileSync(p.target('application.yml'), 'utf8')).toBe(SEED);
    expect(noStrays(dir).sort()).toEqual(['.application.yml.smdb-seed.notes', '.other.yml.smdb-seed.4242.0a1b2c3d']);
  });

  it('names the real kind of a kept entry, and refuses a dangling symlink with a warning', async (ctx) => {
    const dir = path.dirname(p.target('application.yml'));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'real.yml'), 'operator');
    // Windows without the symlink privilege still allows a directory junction,
    // which lstat also reports as a symbolic link.
    let kind: 'file' | 'junction' = 'file';
    try { fs.symlinkSync(path.join(dir, 'real.yml'), p.target('application.yml')); }
    catch {
      kind = 'junction';
      fs.mkdirSync(path.join(dir, 'realdir'));
      try { fs.symlinkSync(path.join(dir, 'realdir'), p.target('application.yml'), 'junction'); }
      catch { ctx.skip(); return; }
    }
    await p.deliver('application.yml');
    expect(logs.some((l) => l.includes('Kept existing symlink') && l.includes('application.yml'))).toBe(true);
    expect(fs.readFileSync(path.join(dir, 'real.yml'), 'utf8')).toBe('operator');

    if (kind === 'junction') fs.rmdirSync(p.target('application.yml')); else fs.unlinkSync(p.target('application.yml'));
    fs.symlinkSync(path.join(dir, 'missing.yml'), p.target('application.yml'), kind === 'junction' ? 'junction' : undefined);
    logs = [];
    await p.deliver('application.yml');
    expect(fs.existsSync(path.join(dir, 'missing.yml'))).toBe(false);
    expect(logs.some((l) => l.includes('Warning') && l.includes('symlink to a missing target') && l.includes('application.yml'))).toBe(true);
    expect(logs.some((l) => l.includes('Kept existing') || l.includes('Delivered file'))).toBe(false);
  });

  it('a directory seed whose files all exist says it kept them, not that it delivered', async () => {
    fs.mkdirSync(p.target('conf'), { recursive: true });
    fs.writeFileSync(path.join(p.target('conf'), 'inner.yml'), 'mine');
    await p.deliver('conf');
    expect(logs.some((l) => l.includes('Kept existing directory') && l.includes('conf'))).toBe(true);
    expect(logs.some((l) => /Delivered dir/.test(l))).toBe(false);
  });

  it('a directory seed reports how many files it delivered and kept', async () => {
    fs.mkdirSync(p.target('conf'), { recursive: true });
    fs.writeFileSync(path.join(p.target('conf'), 'inner.yml'), 'mine');
    fs.writeFileSync(path.join(repo, 'conf', 'second.yml'), SEED);
    await p.deliver('conf');
    expect(logs.some((l) => l.includes('Delivered directory') && l.includes('1 files delivered, 1 existing kept'))).toBe(true);
  });
});
